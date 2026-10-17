# Security Model

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| LLM produces unintended/malicious intent | Intent schema validation + deterministic policy engine deny-by-default |
| Unauthorized transaction signing | Private keys never in source; signing isolated behind `Signer` interface; simulation gate |
| Asset theft via unexpected asset | Allowed-assets allowlist (deny by default) |
| Funds sent to wrong/blacklisted destination | Allowed-destinations allowlist + destination format validation |
| Excessive spending | Per-tx and daily spending limits; approval threshold |
| Replay attacks | Stellar sequence numbers + timebounds on all transactions |
| Policy bypass via malformed intent | Strict schema validation before policy evaluation |
| Signer bypass via direct invocation | Pipeline is the only public entry point; signer is not exposed to callers |
| Secret leakage through API responses | Signer interface has no key-returning methods; activity store asserts no secrets |
| Frontend compromise exposes secrets | Frontend never receives private keys; all signing server-side |
| Daily limit race | Daily spending limit uses read-then-write across the activity store; two near-simultaneous intents can both pass the check before either record lands. Not safe for concurrent writers yet |
| Contract call injection | Contract calls disabled by default; explicit allowlist required |

## Key Management

- **Never**: private keys in source code, environment example files, frontend code, logs, or tests.
- **Server-side**: keys loaded from a secrets manager or KMS at runtime, never committed.
- **Testnet (development only)**: `TestnetLocalSigner` loads a secret key from the `STELLAR_TESTNET_SECRET_KEY` environment variable. It is testnet-only, never committed, never exposed through the API, and never logged.
- **Production planning**: HSM or MPC-based signing with policy-gated access. The `Signer` interface is the seam — production implementations (UserWalletSigner, AgentPermissionSigner, HardwareSigner, KmsSigner) plug in without changing the pipeline.

## LLM Authority Boundaries

The LLM's role is strictly **intent generation**:

```
LLM output (natural language) → Intent schema (typed, validated) → Policy engine → Transaction
```

The LLM:
- May NOT produce raw transaction envelopes or XDR.
- May NOT choose which rules to apply.
- May NOT bypass policy evaluation.
- May NOT sign transactions directly.
- May NOT receive a reference to the Signer.

The policy engine is a **pure function** with no dependency on the LLM or any external state except the explicit rule set.

## Signer Authority Separation

The `Signer` interface is the cryptographic boundary:

```
interface Signer {
  getAccountId(): string;
  getNetworkPassphrase(): string;
  sign(transaction: Transaction): Promise<Transaction>;
}
```

The pipeline holds a `Signer` reference at construction time. The LLM layer never receives one. The interface exposes only the public account ID and network passphrase — never private key material, seeds, or mnemonics.

`TestnetLocalSigner` is **development infrastructure**, not the final wallet architecture. It exists for controlled testing against the Stellar testnet. Production implementations will include:
- `UserWalletSigner` — user-custodied wallet signing (e.g., WalletConnect / xBull / Freighter)
- `AgentPermissionSigner` — scoped on-chain signer with an on-chain policy contract
- `HardwareSigner` / `KmsSigner` — hardware-backed or cloud-KMS-backed signing

These are not yet implemented. The interface is designed so they can be added without changing the pipeline.

## Policy Enforcement

Rules are evaluated in order:

1. **Transaction type restriction** — is this intent type allowed at all? (deny by default)
2. **Amount checks** — exceeds per-tx max? daily limit? requires approval?
3. **Asset allowlist** — is the asset permitted?
4. **Destination allowlist** — is the destination permitted? (payments only)
5. **Contract ID allowlist** — is the contract permitted? (contract calls only)

A single deny short-circuits to `deny`. Amounts at or above the approval threshold return `requires_approval`, routing to a human review queue.

## Transaction Pipeline Gate Order

The pipeline runs each gate in sequence. A failure at any gate aborts the chain:

```
1. Intent validation  (IntentValidator)
2. Policy evaluation (PolicyEngine)
3. Authorization gate (allow + !requires_approval, or pre-approved)
4. Transaction construction (StellarTransactionBuilder)
5. Simulation (StellarSimulator)
6. Signing (Signer — interface-abstracted)
7. Submission (StellarSubmitter)
8. Activity record
```

No individual step is exposed as a public method that callers can chain arbitrarily. `TransactionPipeline.execute()` is the only public entry point.

## Transaction Simulation

Every intent that passes policy evaluation enters the **simulation gate**:

1. Construct the transaction (unsigned) from the validated intent.
2. Call the Stellar Horizon API to verify:
   - The transaction envelope XDR is well-formed.
   - The source account exists.
   - The transaction sequence number is exactly the on-chain sequence + 1.
   - The fee is >= the network base fee.
   - The source account's XLM balance covers amount + fee + minimum reserve.
3. If simulation succeeds: record fee, warnings, operation count. Proceed to signing.
4. If simulation fails: record error, abort. Activity status = `failed`.

Simulation is a MANDATORY gate. A transaction that is not simulated, or whose simulation failed, MUST NOT be signed or submitted. There are no fake or cached simulation results.

## Replay Protection

Stellar's native sequence numbers are used. Each transaction includes:
- Current account sequence number
- Timebounds (valid window)
- (Future) Memo for intent correlation

## Spending Limits

| Limit | Default | Scope |
|-------|---------|-------|
| `maxTxAmount` | 100 XLM | Per-transaction |
| `dailySpendingLimit` | 500 XLM | Per-agent per-day |
| `approvalThreshold` | 50 XLM | Amount at/above requires human approval |

Limits are configurable per-agent via policy rules. The policy engine is the single source of truth.

## Approval Flow

```
Intent passes policy → Simulation succeeds → Decision = requires_approval?
   → YES → Queue for human approval (owner or designated approver)
   → NO  → Proceed to signing
```

Approval state is recorded in the activity log. An approval is bound to a specific intent hash — it cannot be reused for a different intent.

**LIMITATION (Phase 3):** Approval state is persisted in an `ApprovalStore` (SQLite or in-memory). The approve/reject endpoints are stateless HTTP handlers that transition records. Cross-agent approval isolation IS enforced — `canApprove`/`canReject` check that the caller owns the agent via `ResourceAuthorizationService`.

After approval, execution is enqueued through the persistent `ExecutionQueue` with retry and dead-letter semantics. If the process exits mid-execution, the `ExecutionRecoveryService` re-queues stuck records on startup.

## Phase 5: Authorization & Ownership Model

Every agent has an `ownerId`. Authorization is enforced server-side via `RequestContext` + `ResourceAuthorizationService`:

```
Agent {
  id: string;
  ownerId: string;
  stellarAddress: string;
  capabilities: string[];
}

ActivityRecord {
  id: string;
  agentId: string;
  ownerId: string;
  intent: AgentIntent;
  status: string;
}

ApprovalRecord {
  id: string;
  agentId: string;
  ownerId: string;
  status: ApprovalStatus;
}
```

**Authorization Rules:**
- Caller can only read/write own agents
- Caller can only read own activity
- Caller can only read own approvals
- Caller can only approve/reject own approvals
- Cross-owner access returns 404 (not 403) to avoid leaking existence

**Development Identity:** In dev/test, identity is deterministic via `ServerOptions.requestContext: { ownerId }` — no bearer credential is required. Where browser user authentication is enabled, the session cookie resolves the principal instead (ADRs 016–017 in [architecture.md](architecture.md)); `requestContext` remains the fallback used by tests and offline tooling.

**Known Limitation:** The machine-client bearer path (`API_KEYS`) is production-ready. Browser user authentication IS implemented — three providers (email+password, Stellar wallet signature, Google OAuth) issuing HttpOnly `SameSite` session cookies, see `apps/api/src/auth.ts` and ADRs 016–019 in [architecture.md](architecture.md). Its current limitations: OAuth state and Stellar challenges are in-memory (single API process, ADR-019), registration is open by default (ADR-017), and login endpoints have no rate limiting yet (ADR-020, Proposed).

## API Authentication (Development vs Production)

The API server supports two authentication modes, selected by environment
configuration at startup:

### Development mode (default)

When `API_KEYS` is not set, `DevAuthProvider` authenticates every request as a
single development owner (`DEV_OWNER_ID`, default `operator`). This mode exists
for local development and testing only. The dashboard does not require a token.

### Production mode

When `API_KEYS` is set, `ProductionApiKeyAuthProvider` validates requests via
the `Authorization: Bearer <key>` header. Each API key maps to exactly one
server-configured identity.

```
API_KEYS=<key>:<ownerId>:<subject>,<key>:<ownerId>:<subject>
```

- Entries are separated by `,`; fields within an entry by `:`.
- `key` — the credential secret. Generate a cryptographically random value,
  store it as a server-side secret, never commit it, never log it.
- `ownerId` — the owner identity the key maps to. Comes **only** from this
  server-side configuration; a client can never choose or override its
  `ownerId` (verified by `production-auth.test.ts`).
- `subject` — optional identity metadata for the authenticated request.
  Defaults to `key:<first 8 chars>` when omitted.

Behavior:

- Invalid credentials (missing/malformed header, unknown key) → request is
  unauthenticated; protected endpoints return `401`.
- Malformed `API_KEYS` configuration (entry without `key:ownerId`) → the server
  **fails fast at startup** (`process.exit(1)`). It never silently falls back
  to `DevAuthProvider` in production mode.
- An empty `API_KEYS` value is treated as unset → development mode.

See `packages/shared/src/production-auth.ts` and
`apps/api/src/server.ts` for the implementation.

## Emergency Disable Mechanism

(Future work in MVP, but planned as a core primitive)

- The policy engine reads rules from a config that can be hot-swapped.
- An emergency "kill switch" key (held by the deployment operator) can push an all-deny policy to all agents instantly.
- On-chain agent registry supports `deactivate_agent` to permanently tombstone an agent's identity (the id cannot be re-registered, even by the original owner; there is no reactivation entrypoint). `stellar_address` is bound with that address's consent on first registration.

## Frontend / Backend Trust Boundary

```
Frontend (web) ———— no secrets ————> Backend API (api)
   |                                      |
   |  reads public agent data             |  holds keys, policy engine,
   |  displays activity                  |  Stellar adapter, orchestrator
   |  submits intents for approval        |
```

The frontend NEVER receives:
- Private keys or seeds
- Raw signing capability
- Policy rule definitions (only the resulting decision)

All signing happens in the backend through a hardened, isolated path. The frontend can request approval status and view activity records, but cannot trigger signing directly.

## Logging & Audit Trail

Every action produces an `ActivityRecord`:

```
agentId | intent | policyDecision | authorizationStatus | simulationResult | txHash | status | timestamp | error
```

Records are append-only. The store's `record()` method runs `assertNoSecrets()` before persisting — if any field contains a marker like "secret", "seed", "private_key", or "mnemonic", the write is rejected. In the MVP they are stored in the database; future work moves critical fields on-chain via the AgentRegistry contract.
