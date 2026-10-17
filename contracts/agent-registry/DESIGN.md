# agent-registry — DESIGN (pre-rewrite)

Scope: design notes and API mapping for `src/lib.rs`.

## Agent ID format

Agent ids are case-sensitive and are not normalized. They must start with an
ASCII lowercase letter or digit; subsequent bytes may be ASCII lowercase
letters, digits, `.`, `_`, or `-` (`[a-z0-9][a-z0-9._-]*`). Uppercase letters,
whitespace, control characters, punctuation outside that set, and non-ASCII
bytes are rejected. The maximum is 64 UTF-8 bytes, not 64 Unicode characters.
Since the accepted charset is ASCII, accepted ids have the same byte and
character count. The implementation rejects uppercase rather than silently
lowercasing, preserving an explicit one-to-one mapping between input and key.

## Events

Each successful mutation publishes one contract event with the format `("agent", <action>)` as topics and a tuple of relevant identifiers as data. Consumers can subscribe to these events to observe identity lifecycle changes without polling `query()`.

| Entrypoint | Topics | Data |
|---|---|---|
| `register` | `("agent", "registered")` | `(id, owner, stellar_address)` |
| `update_metadata` | `("agent", "updated")` | `(id, owner)` |
| `deactivate` | `("agent", "deactivated")` | `(id, owner)` |

- Events are published **only on success** — failed mutations (validation errors, unauthorized access, deactivated tombstone) emit no events.
- Events are published via `env.events().publish()` using `String` topic values (not `Symbol`), so topic matching in tests uses `try_into_val::<_, String>()`.
- A negative test (`test_failed_register_emits_no_event`) and a second negative test (`test_failed_update_emits_no_event`) verify that rejected calls emit nothing.

## Entrypoints — intended behavior (inferred from names, doc comments, tests)

| Fn | Intended | Mutates? |
|---|---|---|
| `register(id, display_name, stellar_address, capabilities) -> AgentInfo` | Caller becomes owner; store new `AgentInfo` keyed by `id`; reject duplicate id ("agent already registered"); `active=true`, `created_at=updated_at=ledger timestamp` | yes |
| `update_metadata(id, new_display_name, new_capabilities) -> AgentInfo` | Overwrite display_name + capabilities, bump `updated_at`. Doc: "Only ***" — caller must equal stored `info.owner`, else "not authorized" | yes |
| `deactivate(id) -> bool` | PERMANENT tombstone: `active=false`, bump `updated_at`. Auth: owner only (same "not authorized" rule). The id cannot be re-registered afterwards — by anyone, including the original owner — and there is no reactivation entrypoint | yes |
| `query(id) -> Option<AgentInfo>` | Read-only lookup, public ("Anyone can query"). Pure read: mutates no storage and extends no TTL | no |

Module doc also lists `register_agent(...)`/`deactivate_agent(...)` — actual fn names are `register`/`deactivate`; doc drift, note only.

## Intended auth rule per mutating entrypoint

- `register`: implicit — `owner = caller` (no check needed; whoever calls owns it). Caller identity must be the **authenticated invoker**.
- `update_metadata`: `require(owner)` where owner = stored `AgentInfo.owner`.
- `deactivate`: same owner check.
- No admin/root concept anywhere. No delegation check despite sibling `permissions` crate existing (see Questions).

## Invented APIs → real soroban-sdk 22 equivalents

All verified against `soroban-sdk 22.0.7` source (`~/.cargo/registry/.../soroban-sdk-22.0.7/src/`).

| # | As written | Reality | Real equivalent |
|---|---|---|---|
| 1 | `env.invoker()` (3×) | No such method on `Env` in any installed sdk (checked 20.5/21.7/22.0/25.3/28.0) | Canonical pattern: add `caller: Address` param + `caller.require_auth()` (address.rs:226); read identity as `caller` |
| 2 | `Symbol::from_str(&env, ...)` runtime (4×) | `Symbol` has no runtime `from_str`; only `TryFromVal<Env,&str>` for ≤9-char small syms, `Symbol::new` is deprecated → `symbol_short!` | Dynamic keys: composite key via `#[contracttype]` enum/struct, e.g. `DataKey::Agent(String)`; static keys: `symbol_short!("agent")` |
| 3 | `format!("agent:{}", id)` on soroban `String` (4×) | `soroban_sdk::String` doesn't impl `Display`; `format!` is std/alloc macro, gone under `no_std` | No string interpolation on-chain. Store structured key `(symbol_short!("agent"), id)` or contracttype enum variant holding `String` |
| 4 | `AgentInfo` plain `#[derive(Clone,Debug,Eq,PartialEq)]` used as storage value + return type | Storage/Val conversion needs the type's `TryFromVal` impls → only `#[contracttype]` generates them (7× E0277) | Add `#[contracttype]` derive (soroban-spec type); drop `Debug`/`PartialEq` derives if they collide (contracttype derives its own) |
| 5 | `env.storage().instance()` for per-agent records | API exists (storage.rs:140) but instance storage is keyed per contract instance, limited size, and 1 key → whole-agent map impossible with dynamic keys; also `instance()` entries die on instance restore/expiry | `env.storage().persistent()` for AgentInfo records (storage.rs:88); `instance()` only for singleton state |
| 6 | `.get(&key).unwrap()` on missing key | `unwrap` on `Option` works but panics with std panic message; contract idiom is explicit error | `Error::ContractNotReady`-style custom `#[contracterror]` enum, or `panic!("...")` — decide (Questions) |
| 7 | Tests: `env.register_contract(None, AgentRegistry)` | Exists ONLY with `testutils` feature (env.rs:789, cfg-gated) — dev-dep already enables it. OK as-is | no change needed |
| 8 | Tests: `#[should_panic(expected="not authorized")]` on empty fn | Empty test body = passes vacuously (test #3 currently proves nothing). Under real sdk, `require_auth` failures surface as `Error(AuthFailed)` from `client.call()`, not a panic string | Rewrite: second `Address::generate(&env)`, expect Err, or `#[should_panic]` matching the sdk auth error when using client without mock auth |
| 9 | `use soroban_sdk::testutils::Ledger` (unused import) | Real path is `soroban_sdk::testutils::Ledger` but unused here | drop import |

`format!` + `Symbol::from_str` also appear in sibling `permissions/src/lib.rs` (delegate/revoke/check, ~9 sites) + that crate's `delegate` has **no auth check at all** while its doc says "Only the from_agent owner can grant". Same rewrite wave needed there.

## Ambiguities — questions, NOT guessed

1. **`id` type**: registry keys are agent names like `"agent_1"`. Are ids opaque `String` (any bytes) or should they be constrained (max len, charset)? Storage key design (`contracttype` enum with `String` variant) works either way, but validation rule is a product decision.
2. **`stellar_address: String` field**: doc says agents have a Stellar address, but it's stored as an unvalidated `String` (`"GADDR"` in tests). Should it be `Address` type (validated strkey) instead? Changes the register signature.
3. **Duplicate register**: currently panics. Alternative: return existing `AgentInfo` (idempotent) or `Error::AlreadyRegistered`. Which?
4. **Re-activation**: `deactivate` is a PERMANENT tombstone — the id cannot be re-registered and there is no `activate` entrypoint. **RESOLVED (security review):** this is intentional. `update_metadata` additionally rejects a deactivated agent (`Error::Deactivated`). A reactivate/ownership-transfer primitive is deliberately out of scope; see draft issue (c).
5. **`capabilities: Vec<String>` bounds**: **RESOLVED (security review):** bounded. `MAX_CAPABILITIES=32` entries, each `MAX_CAPABILITY_LEN=32` bytes; `MAX_DISPLAY_NAME_LEN=128` bytes. Excess is rejected with a typed `Error` variant, enforced on both `register` and `update_metadata`.
6. **`instance` vs `persistent`**: current code writes per-agent records into *instance* storage (per-contract, size-limited, expiry-prone). Assume that was incidental (author meant persistent), correct?
7. **Auth of `register` when called via another contract**: `require_auth(caller)` semantics differ for contracts-as-callers. Should cross-contract registration be allowed in MVP or force EOA owners?
8. **`deactivate -> bool` always `true`**: return value meaningless. Keep (API compat) or return `Result`-style error on unknown id (currently `.unwrap()` panics on missing id — vs `update_metadata` same)? Should unknown-id in update/deactivate panic, or return error?
9. **`test_update_rejects_non_owner` is an empty placeholder** — author knew ("Real test uses env.invoker() switching"). Needs `env.mock_all_auths()`/`as_contract` + second address. Confirm we rewrite tests as part of implementation, keeping the 4 intents.
10. **`query` return**: `Option<AgentInfo>`; but returned through host as `Val` — after `#[contracttype]` this is fine. Confirm no need for "include deactivated" filter param.
