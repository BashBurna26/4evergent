# Soroban Agent Registry — Integration Guide

This document explains how to call the **deployed** `agent-registry` contract on
Stellar Testnet from TypeScript. It assumes you have completed the deploy steps
in [`testnet.md`](testnet.md) and that the contract is already on testnet.

- **Deployed contract ID:** `CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7`
- **Network:** Test SDF `Network ; September 2015` (Stellar Testnet)
- **RPC endpoint:** `https://soroban-testnet.stellar.org` (no mainnet path exists in this repo)
- **Full design doc:** [`contracts/agent-registry/DESIGN.md`](../contracts/agent-registry/DESIGN.md)
- **API surface (10 HTTP routes):** [`api.md`](api.md) — User Authentication section
- **Deploy commands:** [`testnet.md`](testnet.md) — Soroban Contract section
- **Capability table:** [`capabilities.md`](capabilities.md)

The contract is **not** invoked by the transaction pipeline today — see
[Status](#status-pipeline-does-not-invoke-contracts-yet) and the
`contract_call` policy note below. Direct SDK calls
are the current integration path.

---

## Quick start: query an agent

```ts
import { Contract, nativeToScVal, scValToNative, Account, Keypair, Networks, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

const CONTRACT_ID = "CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7";
const RPC_URL = "https://soroban-testnet.stellar.org";

const contract = new Contract(CONTRACT_ID);
const server = new rpc.Server(RPC_URL);

// query() is auth-free — any keypair can construct the read transaction.
const caller = Keypair.random();
const account = new Account(caller.publicKey(), "1");

const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
  .setTimeout(30)
  .addOperation(contract.call("query", nativeToScVal("deploy_smoke")))
  .build();

const sim = await server.simulateTransaction(tx);

// simulateTransaction returns a union. An unsuccessful simulation is NOT a
// rejected promise — it is a SimulateTransactionErrorResponse with a
// non-empty `error` string. Handle it explicitly; do NOT collapse it to
// null, because a successful query of a missing agent also yields null.
if (!rpc.Api.isSimulationSuccess(sim)) {
  throw new Error(`simulation failed: ${sim.error}`);
}

// Only now is it safe to decode the return value. A successful simulation
// still has two distinct null-producing outcomes:
//   - retval is scvVoid  -> the contract returned an Error variant
//     (e.g. InvalidIdChar for a malformed id)
//   - retval decodes to null -> Ok(None): the id is valid but no record exists
const retval = sim.result?.retval;
if (!retval || retval.switch().name === "scvVoid") {
  throw new Error("contract returned an error (scvVoid retval)");
}
const info = scValToNative(retval);
// { id, owner, display_name, stellar_address, capabilities, created_at, updated_at, active }
```

### Verified testnet responses

Against the live contract at `CDXQRPVGMPJB5UXQHKFAPBLK6G37DSVKDW2BKRAF76RO5ENCCB4W3QX7`:

| Query input | `retval` on success | When |
|---|---|---|
| `"deploy_smoke"` (registered) | `scvMap` with 8 keys: `active`, `capabilities`, `created_at`, `display_name`, `id`, `owner`, `stellar_address`, `updated_at` | Record exists |
| `"not_registered"` (never registered) | `scvVoid` decoding to `null` (`Ok(None)`) | Record missing — **not an error**, `query` returns `Option<AgentInfo>` |
| `"UPPER"` (uppercase = invalid charset) | `scvVoid` | Contract returned `Error(InvalidIdChar)` — the envelope simulates fine, and the diagnostic events carry `Error(WasmVm, InvalidAction)` |

`"not_registered"` and `"UPPER"` both return `scvVoid` at the `ScVal` level —
they are indistinguishable by retval alone. The difference is observable in the
simulation's diagnostic events (the error case carries a
`[Diagnostic Event] topics:[error, Error(WasmVm, InvalidAction)]` entry). If you
need to distinguish them in code, either validate the id format before calling,
or parse `sim.events` for the error topic.

`created_at`/`updated_at` arrive as `bigint` (Unix seconds); convert with
`Number(...)` or `new Date(Number(v) * 1000)`. `owner` and `stellar_address`
decode to `G...`-prefixed account strings.

> **Note on unsigned writes:** `register`, `update_metadata`, and
> `deactivate` each call `caller.require_auth()` (see
> [`contracts/agent-registry/src/lib.rs:160`](contracts/agent-registry/src/lib.rs)),
> so a write transaction simulated without a matching `Auth` entry returns
> `InvalidAction` at simulation time. Signing a Soroban auth context for the
> acting address is required — see the Stellar SDK `prepareTransaction` +
> `signAuthEntry` flow. The test suite mocks this via `MockAuth`
> ([`contracts/agent-registry/src/lib.rs:304-310`](contracts/agent-registry/src/lib.rs));
> production callers sign with the user's wallet.

---

## Rust → TypeScript type mapping

### `AgentInfo` → native object

Defined in `contracts/agent-registry/src/lib.rs:51-62`:

```rust
pub struct AgentInfo {
    pub id: String,
    pub owner: Address,
    pub display_name: String,
    pub stellar_address: Address,
    pub capabilities: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
}
```

| Rust field | Soroban `ScVal` | TypeScript via `scValToNative` |
|---|---|---|
| `id: String` | `ScVal::String` | `string` |
| `owner: Address` | `ScVal::Bytes` (16-byte curve25519, prefix-scrambled) | `string` (`G...`) |
| `display_name: String` | `ScVal::String` | `string` |
| `stellar_address: Address` | `ScVal::Bytes` | `string` (`G...`) |
| `capabilities: Vec<String>` | `ScVal::Vec` of `ScVal::String` | `string[]` |
| `created_at: u64` | `ScVal::U64` | `bigint` |
| `updated_at: u64` | `ScVal::U64` | `bigint` |
| `active: bool` | `ScVal::Bool` | `boolean` |

All eight fields are present in `query()` return value when a record exists.
`created_at`/`updated_at` are `bigint` in the SDK return — convert with
`Number(v)` if you need a plain number.

### `Error` → numeric code

Defined in `contracts/agent-registry/src/lib.rs:72-86` (`#[repr(u32)]`):

| Name | Code | Returned when |
|---|---|---|
| `IdEmpty` | 1 | `id` is an empty string (`lib.rs:93`) |
| `IdTooLong` | 2 | `id.len() > 64` bytes (`lib.rs:95`) |
| `AlreadyRegistered` | 3 | An agent with that `id` already exists at `/agents/<id>` (`lib.rs:168-169`) |
| `NotFound` | 4 | `update_metadata`/`deactivate` look up an unknown id (`lib.rs:209,244`) |
| `NotAuthorized` | 5 | Caller authenticated but is not the `owner` (`lib.rs:210-211,245-246`) |
| `Deactivated` | 6 | Record exists but `active == false` and a mutation is attempted (`lib.rs:214-215`) |
| `DisplayNameTooLong` | 7 | `display_name.len() > 128` bytes (`lib.rs:117-118`, `lib.rs:216`) |
| `TooManyCapabilities` | 8 | `capabilities.len() > 32` (`lib.rs:124-125`, `lib.rs:217`) |
| `CapabilityTooLong` | 9 | A single capability string exceeds 32 bytes (`lib.rs:128-129`) |
| `InvalidIdChar` | 10 | `id` contains characters outside `[a-z0-9._-]` or starts with `.` / `_` / `-` (`lib.rs:107-110`) |

**Reading errors from a TypeScript call:** a contract `Error` return is not a
transaction-envelope failure — the envelope simulates, but the contract-level
return is `Void` (`scvVoid`). After `sendTransaction` completes and you fetch
the transaction result, inspect `result.meta` / the returned `ScVal`: an `scvVoid`
retval on a write where success returns `AgentInfo`/`bool` signals a contract
error, and the specific variant is surfaced as a Soroban `Error(WasmVm, …)` —
map it via the code above. `query()` returning `scvVoid` for an invalid id
(verified for `"UPPER"`) is the same mechanism: `validate_id` runs on the read
path and returns `InvalidIdChar` (code 10) before the storage lookup.

---

## The four entry points

### `query(id) -> Option<AgentInfo>` (auth-free, read)

```ts
const tx = new TransactionBuilder(account, {...})
  .addOperation(contract.call("query", nativeToScVal("agent_id")))
  .build();
const sim = await server.simulateTransaction(tx);
// Same guard as the quick start: the simulation union must be resolved first.
const result = rpc.Api.isSimulationSuccess(sim) ? sim.result : null;
const info = result?.retval ? scValToNative(result.retval) : null;
// info is AgentInfo | null  (null = valid id, no record — Ok(None))
```

- Returns `null` when the id does not exist (Ok(None)) — **not an error**.
- Still validates the id format and returns `Error(InvalidIdChar)` for an
  invalid charset — the retval will be `scvVoid` in that case.
- Reads only; extends no TTL (module doc `contracts/agent-registry/src/lib.rs:25`).

### `register(caller, id, display_name, stellar_address, capabilities) -> AgentInfo` (auth: caller)

- First parameter is the acting `Address` (requires `require_auth`).
- If `stellar_address != caller`, that address must also authenticate
  (consent to be bound — see `contracts/agent-registry/src/lib.rs:161-163`).
- Fails `AlreadyRegistered` if the id is taken.
- Emits event `("agent", "registered")` with data `(id, owner, stellar_address)`.
- Extends both the record entry TTL and the contract instance TTL
  (`bump_ttl`, `contracts/agent-registry/src/lib.rs:139-144`).

### `update_metadata(caller, id, new_display_name, new_capabilities) -> AgentInfo` (auth: owner)

- `caller` must be the `owner` of the record (`contracts/agent-registry/src/lib.rs:204,210`).
- Fails `Deactivated` if the record is a tombstone (`contracts/agent-registry/src/lib.rs:214`).
- Re-validates name length / capability count / capability length.
- Emits `("agent", "updated")` with data `(id, owner)`.

### `deactivate(caller, id) -> bool` (auth: owner)

- A **permanent tombstone**: `active` set to `false`, record stays queryable,
  the id can never be re-registered (`contracts/agent-registry/src/lib.rs:233-234`).
- Fails `Deactivated` if already inactive (no-op, not an error).
- Emits `("agent", "deactivated")` with data `(id, owner)`.

---

## Authorization model

| Entrypoint | Who may call | Auth mechanism |
|---|---|---|
| `query` | Anyone | None |
| `register` | Any authenticated address (becomes owner) | `caller.require_auth()`; if `stellar_address != caller`, that address also authenticates |
| `update_metadata` | The current `owner` of the agent | `caller.require_auth()` + `info.owner == caller` check |
| `deactivate` | The current `owner` of the agent | `caller.require_auth()` + `info.owner == caller` check |

This is enforced in `contracts/agent-registry/src/lib.rs:160,204,237` — every
mutation entrypoint calls `caller.require_auth()` as its first statement, and
`update_metadata`/`deactivate` additionally gate on `info.owner == caller`.
`query` performs no auth check.

### Error summary for authorization calls

- Caller fails `require_auth()` → no contract Error variant; the invocation is
  rejected at the host level (no `ScVal` retval).
- Authenticated-but-not-owner → `NotAuthorized` (code 5).
- Target record not found → `NotFound` (code 4).

---

## Agent id format

- 1–64 bytes, measured in UTF-8 bytes.
- First character must be an ASCII lowercase letter `[a-z]` or digit `[0-9]`.
- Subsequent characters: `[a-z0-9._-]`.
- Case-sensitive — uppercase letters are rejected with `InvalidIdChar` (code 10),
  not lowercased. The implementation is explicit rather than normalizing
  (`contracts/agent-registry/src/lib.rs:107-110`).

## Size limits

| Field | Max | Enforced at |
|---|---|---|
| `id` | 64 bytes | `register` + `query` (validate_id) |
| `display_name` | 128 bytes | `register` + `update_metadata` |
| `capabilities` (count) | 32 entries | `register` + `update_metadata` |
| single capability string | 32 bytes | `register` + `update_metadata` |

---

## TTL / state-liveness model

- Agent records live in **persistent** storage under `DataKey::Agent(id)`
  (`contracts/agent-registry/src/lib.rs:21-22,64-70`).
- Every **write** path (`register`, `update_metadata`, `deactivate`) calls
  `bump_ttl()` to push both the record entry's TTL and the contract instance
  TTL toward the ledger maximum (`contracts/agent-registry/src/lib.rs:139-144`).
- `query` is a pure read: it mutates no storage and extends no TTL
  (`contracts/agent-registry/src/lib.rs:261-263`).
- A record with no write for longer than the network TTL ceiling is **archived**,
  not deleted; it must be restored (automatic via RPC simulation) before it can
  be read or written again (`contracts/agent-registry/src/lib.rs:28-31`).
- `register` on an archived-but-restored id still fails with
  `AlreadyRegistered` — archual is not a tombstone.

The test suite verifies the TTL behavior: `register`/`update_metadata`/
`deactivate` each extend the instance TTL, and `query` leaves both the entry
and instance TTL unchanged
(`contracts/agent-registry/src/lib.rs:790-912`).

---

## Events

Each successful mutation publishes one contract event with topics
`("agent", <action>)` — see
[`contracts/agent-registry/DESIGN.md`](contracts/agent-registry/DESIGN.md) for
the full schema.

| Action | Topics | Data |
|---|---|---|
| `register` | `("agent", "registered")` | `(id, owner, stellar_address)` |
| `update_metadata` | `("agent", "updated")` | `(id, owner)` |
| `deactivate` | `("agent", "deactivated")` | `(id, owner)` |

Failed mutations emit **no** event — the tests assert this
(`contracts/agent-registry/src/lib.rs:1015-1057`).

---

## How this fits the rest of the API

This contract is the on-chain anchor for agent identity. The HTTP API in
`apps/api/src/index.ts` (`/agents`, `/agents/:id`, etc.) records agents in a
SQLite store that **mirrors** the contract's `AgentInfo` shape (see
[`packages/shared/src/types.ts`](packages/shared/src/types.ts) and
[`docs/api.md`](api.md), "Agents" section). The two are not yet reconciled
automatically — direct SDK calls against the deployed contract are the
integration path until the pipeline consumes Soroban (see below).

---

## Status: pipeline does not invoke contracts yet

- The intent schema supports `contract_call`
  (`packages/shared/src/types.ts:93-102`), but the default policy sets
  `txTypeRestrictions.contract_call = false` (`packages/policy/src/validation.ts:176`),
  so a contract-call intent is denied unless an operator explicitly opts in and
  populates `allowedContractIds`.
- The transaction pipeline (`packages/stellar/src/transaction-builder.ts`)
  builds classic Stellar payment/trustline transactions; it does not yet
  construct Soroban contract invocations.
- This is an intentional Phase 28 decision — Soroban contract execution is
  gated on the policy+approval flow so that even contract writes inherit the
  same spending limits, destination allowlists, and approval thresholds as
  classic payments.

In short: call the contract directly via the SDK today; in a future phase the
pipeline will route `contract_call` intents through it after policy evaluation.
