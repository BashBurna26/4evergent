//! AgentRegistry — on-chain agent identity on Soroban.
//!
//! MVP supports:
//! - register(caller, id, display_name, stellar_address, capabilities)
//! - update_metadata(caller, id, new_display_name, new_capabilities)
//! - deactivate(caller, id)
//! - query(id)
//! - authorization: every *** entrypoint takes the acting `Address` and
//!   calls `require_auth()` as its first statement; only the registered owner
//!   may update/deactivate their own agent.
//!
//! Events: each successful mutation publishes a contract event with topics
//! `("agent", <action>)` — see `DESIGN.md` for the full event schema.
//!
//! Lifecycle/TTL model:
//! - Agent records live in *persistent* storage under `DataKey::Agent(id)`.
//! - Every WRITE path (register, update_metadata, deactivate) extends both the
//!   record entry's TTL and the contract instance TTL toward the ledger max.
//! - `query` is a pure read: it mutates no storage and extends no TTL. Records
//!   are kept alive by owner writes, or by anyone submitting an
//!   `ExtendFootprintTTL` operation on the record's entry.
//! - A record with no write for longer than the network TTL ceiling is archived,
//!   not deleted. It must be restored (automatic when the transaction is
//!   simulated via RPC) before it can be read or written, and `register` on
//!   that id still fails with AlreadyRegistered after restore.
//!
//! Future: delegation, multi-sig registration, capability discovery events.

#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env, String, Vec};

/// Max accepted length of an agent id, in bytes.
const MAX_ID_LEN: u32 = 64;

/// Max accepted length of `display_name`, in bytes.
const MAX_DISPLAY_NAME_LEN: u32 = 128;

/// Max number of entries in `capabilities`.
const MAX_CAPABILITIES: u32 = 32;

/// Max accepted length of a single capability string, in bytes.
const MAX_CAPABILITY_LEN: u32 = 32;

#[contracttype]
#[derive(Clone)]
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

/// Per-agent records live under a single-key enum so the key type is
/// `#[contracttype]`-convertible (dynamic `String` payload supported).
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Agent(String),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    IdEmpty = 1,
    IdTooLong = 2,
    AlreadyRegistered = 3,
    NotFound = 4,
    NotAuthorized = 5,
    Deactivated = 6,
    DisplayNameTooLong = 7,
    TooManyCapabilities = 8,
    CapabilityTooLong = 9,
}

#[contract]
pub struct AgentRegistry;

fn validate_id(id: &String) -> Result<(), Error> {
    if id.is_empty() {
        return Err(Error::IdEmpty);
    }
    if id.len() > MAX_ID_LEN {
        return Err(Error::IdTooLong);
    }
    Ok(())
}

fn validate_display_name(name: &String) -> Result<(), Error> {
    if name.len() > MAX_DISPLAY_NAME_LEN {
        return Err(Error::DisplayNameTooLong);
    }
    Ok(())
}

fn validate_capabilities(caps: &Vec<String>) -> Result<(), Error> {
    if caps.len() > MAX_CAPABILITIES {
        return Err(Error::TooManyCapabilities);
    }
    for cap in caps.iter() {
        if cap.len() > MAX_CAPABILITY_LEN {
            return Err(Error::CapabilityTooLong);
        }
    }
    Ok(())
}

/// Push both the record entry's TTL and the contract instance's TTL toward the
/// ledger max. Called on every WRITE path only: an actively-used record must
/// not be archived just because its instance outlived its default lifetime.
/// `query` deliberately does not call this — it is a pure read.
fn bump_ttl(env: &Env, key: &DataKey) {
    let max = env.storage().max_ttl();
    let threshold = max / 2;
    env.storage().persistent().extend_ttl(key, threshold, max);
    env.storage().instance().extend_ttl(threshold, max);
}

#[contractimpl]
impl AgentRegistry {
    /// Register a new agent. The caller becomes the owner. When
    /// `stellar_address` is a party other than the caller, that address must
    /// authenticate too — an agent can only be bound to an address with its
    /// consent. The caller is never asked to authenticate twice.
    pub fn register(
        env: Env,
        caller: Address,
        id: String,
        display_name: String,
        stellar_address: Address,
        capabilities: Vec<String>,
    ) -> Result<AgentInfo, Error> {
        caller.require_auth();
        if stellar_address != caller {
            stellar_address.require_auth();
        }
        validate_id(&id)?;
        validate_display_name(&display_name)?;
        validate_capabilities(&capabilities)?;
        let key = DataKey::Agent(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }
        let now = env.ledger().timestamp();
        let info = AgentInfo {
            id: id.clone(),
            owner: caller.clone(),
            display_name,
            stellar_address,
            capabilities,
            created_at: now,
            updated_at: now,
            active: true,
        };
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        env.events().publish(
            (
                String::from_str(&env, "agent"),
                String::from_str(&env, "registered"),
            ),
            (id, caller, info.stellar_address.clone()),
        );
        Ok(info)
    }

    /// Update display_name and capabilities. Only the registered owner, and
    /// only while the agent is still active.
    pub fn update_metadata(
        env: Env,
        caller: Address,
        id: String,
        new_display_name: String,
        new_capabilities: Vec<String>,
    ) -> Result<AgentInfo, Error> {
        caller.require_auth();
        let key = DataKey::Agent(id.clone());
        let mut info: AgentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if info.owner != caller {
            return Err(Error::NotAuthorized);
        }
        if !info.active {
            return Err(Error::Deactivated);
        }
        validate_display_name(&new_display_name)?;
        validate_capabilities(&new_capabilities)?;
        info.display_name = new_display_name;
        info.capabilities = new_capabilities;
        info.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        env.events().publish(
            (
                String::from_str(&env, "agent"),
                String::from_str(&env, "updated"),
            ),
            (id, caller),
        );
        Ok(info)
    }

    /// Deactivate the agent — a PERMANENT tombstone. The record stays
    /// queryable, but the id can never be re-registered (even by this owner)
    /// and there is no reactivation entrypoint. Only the registered owner.
    pub fn deactivate(env: Env, caller: Address, id: String) -> Result<bool, Error> {
        caller.require_auth();
        let key = DataKey::Agent(id.clone());
        let mut info: AgentInfo = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)?;
        if info.owner != caller {
            return Err(Error::NotAuthorized);
        }
        info.active = false;
        info.updated_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &info);
        bump_ttl(&env, &key);
        env.events().publish(
            (
                String::from_str(&env, "agent"),
                String::from_str(&env, "deactivated"),
            ),
            (id, caller),
        );
        Ok(true)
    }

    /// Query agent info. Anyone can query. This is a **pure read**: it performs
    /// no storage mutation and extends no TTL (see module docs).
    pub fn query(env: Env, id: String) -> Result<Option<AgentInfo>, Error> {
        validate_id(&id)?;
        let key = DataKey::Agent(id);
        Ok(env.storage().persistent().get(&key))
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{
            storage::Instance as _, storage::Persistent as _, Address as _, Events as _,
            Ledger as _, MockAuth, MockAuthInvoke,
        },
        vec, IntoVal, TryIntoVal, Val,
    };
    use std::println;

    /// 64 bytes — at the limit, must be accepted.
    const ID_64: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    /// 65 bytes — one over, must be rejected.
    const ID_65: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    /// Unwrap the contract error from a generated `try_*` result without
    /// clippy's `err_expect` lint (the Ok payloads don't implement `Debug`,
    /// so `.expect_err()` cannot be used here).
    type TryOutcome<T> =
        Result<Result<T, soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>>;

    fn want_err<T>(res: TryOutcome<T>) -> Error {
        match res {
            Ok(_) => panic!("expected an error result, got success"),
            Err(Ok(contract_error)) => contract_error,
            Err(Err(_)) => panic!("expected a contract error, got an invoke error"),
        }
    }

    fn setup() -> (Env, Address, AgentRegistryClient<'static>) {
        let env = Env::default();
        let contract_id = env.register(AgentRegistry, ());
        let client = AgentRegistryClient::new(&env, &contract_id);
        (env, contract_id, client)
    }

    fn key(env: &Env, id: &str) -> Val {
        DataKey::Agent(String::from_str(env, id)).into_val(env)
    }

    /// Read the TTL of an agent record entry.
    fn entry_ttl(env: &Env, cid: &Address, id: &str) -> u32 {
        env.as_contract(cid, || env.storage().persistent().get_ttl(&key(env, id)))
    }

    /// Read the TTL of the contract instance.
    fn instance_ttl(env: &Env, cid: &Address) -> u32 {
        env.as_contract(cid, || env.storage().instance().get_ttl())
    }

    fn register(env: &Env, client: &AgentRegistryClient, owner: &Address, id: &String, name: &str) {
        client.register(
            owner,
            id,
            &String::from_str(env, name),
            owner,
            &Vec::new(env),
        );
    }

    #[test]
    fn test_register_and_query() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");

        let info = client.register(
            &owner,
            &id,
            &String::from_str(&env, "Test Agent"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(info.id, id);
        assert_eq!(info.owner, owner);
        assert!(info.active);
        assert_eq!(info.created_at, info.updated_at);

        let queried = client.query(&id).unwrap();
        assert_eq!(queried.id, id);
    }

    #[test]
    fn test_duplicate_register_rejected() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        let res = client.try_register(
            &owner,
            &id,
            &String::from_str(&env, "B"),
            &owner,
            &Vec::new(&env),
        );
        // try_ returns Result<Result<T, T::Error>, Result<E, InvokeError>>
        let err = want_err(res);
        assert_eq!(err, Error::AlreadyRegistered);

        // Never overwrite: the original record is untouched.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    #[test]
    fn test_mutation_by_non_owner_rejected_without_mock() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        // Drop all auth mocks: stranger is not authenticated at all.
        env.set_auths(&[]);
        let stranger = Address::generate(&env);
        let res = client.try_update_metadata(
            &stranger,
            &id,
            &String::from_str(&env, "Hacked"),
            &Vec::new(&env),
        );
        assert!(res.is_err(), "unauthenticated caller must be rejected");

        // Now authenticate the stranger for this call only: they pass
        // require_auth() but are not the owner -> NotAuthorized.
        let name = String::from_str(&env, "Hacked");
        let caps = Vec::<String>::new(&env);
        let args: soroban_sdk::Vec<Val> = vec![
            &env,
            stranger.clone().into_val(&env),
            id.clone().into_val(&env),
            name.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "update_metadata",
            args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &invoke,
        }]);
        let res = client.try_update_metadata(&stranger, &id, &name, &caps);
        let err = want_err(res);
        assert_eq!(err, Error::NotAuthorized);

        // State unchanged.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    #[test]
    fn test_mutation_by_owner_succeeds_with_scoped_mock() {
        let (env, cid, client) = setup();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        let name_a = String::from_str(&env, "A");
        let name_b = String::from_str(&env, "B");
        let caps = Vec::<String>::new(&env);

        // Scoped mock: only `owner` is authorized, only for `register`.
        let reg_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
            name_a.clone().into_val(&env),
            owner.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let reg_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "register",
            args: reg_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &reg_invoke,
        }]);
        client.register(&owner, &id, &name_a, &owner, &caps);

        // Scoped mock: only `owner`, only for `update_metadata`.
        env.set_auths(&[]);
        let upd_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
            name_b.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let upd_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "update_metadata",
            args: upd_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &upd_invoke,
        }]);
        let updated = client.update_metadata(&owner, &id, &name_b, &caps);
        assert_eq!(updated.display_name, name_b);

        // And deactivate by the owner.
        env.set_auths(&[]);
        let deact_args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id.clone().into_val(&env),
        ];
        let deact_invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "deactivate",
            args: deact_args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &deact_invoke,
        }]);
        assert!(client.deactivate(&owner, &id));
        assert!(!client.query(&id).unwrap().active);
    }

    #[test]
    fn test_id_validation() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);

        // Empty id.
        let empty = String::from_str(&env, "");
        let res = client.try_register(
            &owner,
            &empty,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::IdEmpty);

        // 65 bytes -> too long.
        let too_long = String::from_str(&env, ID_65);
        let res = client.try_register(
            &owner,
            &too_long,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::IdTooLong);

        // Exactly 64 bytes -> accepted.
        let max = String::from_str(&env, ID_64);
        client.register(
            &owner,
            &max,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(client.query(&max).unwrap().id, max);
    }

    #[test]
    fn test_unknown_id_errors() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let missing = String::from_str(&env, "nope");

        let res = client.try_update_metadata(
            &owner,
            &missing,
            &String::from_str(&env, "X"),
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::NotFound);

        let res = client.try_deactivate(&owner, &missing);
        assert_eq!(want_err(res), Error::NotFound);

        // query on an unknown id is Ok(None), not an error.
        assert!(client.query(&missing).is_none());
    }

    #[test]
    fn test_deactivate() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "Test");

        client.deactivate(&owner, &id);
        let info = client.query(&id).unwrap();
        assert!(!info.active);
        // Tombstone: still readable, metadata preserved.
        assert_eq!(info.display_name, String::from_str(&env, "Test"));
    }

    // ---- regression tests for the independent security review fixes ----

    // F3: update_metadata rejects a deactivated agent (permanent tombstone).
    #[test]
    fn test_update_metadata_rejects_deactivated() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        register(&env, &client, &owner, &id, "A");
        client.deactivate(&owner, &id);

        let res = client.try_update_metadata(
            &owner,
            &id,
            &String::from_str(&env, "AFTER"),
            &Vec::new(&env),
        );
        let err = want_err(res);
        assert_eq!(err, Error::Deactivated);

        // State untouched: display_name still "A", still inactive.
        let info = client.query(&id).unwrap();
        assert!(!info.active);
        assert_eq!(info.display_name, String::from_str(&env, "A"));
    }

    // F4: binding stellar_address to a third party requires that party's consent.
    #[test]
    fn test_register_requires_stellar_address_consent() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let victim = Address::generate(&env);
        let id = String::from_str(&env, "a1");

        // mock_all_auths satisfies every address, so binding succeeds:
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &victim,
            &Vec::new(&env),
        );
        assert_eq!(client.query(&id).unwrap().stellar_address, victim);

        // Scoped mock: authenticate ONLY the caller, only for `register`.
        // The caller's own require_auth() therefore passes, so the call can
        // only fail because `stellar_address` (victim) never authenticated.
        // Without the F4 fix this call would succeed.
        env.set_auths(&[]);
        let id2 = String::from_str(&env, "a2");
        let name = String::from_str(&env, "A");
        let caps = Vec::<String>::new(&env);
        let args: soroban_sdk::Vec<Val> = vec![
            &env,
            owner.clone().into_val(&env),
            id2.clone().into_val(&env),
            name.clone().into_val(&env),
            victim.clone().into_val(&env),
            caps.clone().into_val(&env),
        ];
        let invoke = MockAuthInvoke {
            contract: &cid,
            fn_name: "register",
            args,
            sub_invokes: &[],
        };
        env.mock_auths(&[MockAuth {
            address: &owner,
            invoke: &invoke,
        }]);
        let res = client.try_register(&owner, &id2, &name, &victim, &caps);
        assert!(
            res.is_err(),
            "caller-only auth must not be enough to bind a third-party stellar_address"
        );
        assert!(
            client.query(&id2).is_none(),
            "rejected register must leave no record"
        );
    }

    // F5: metadata size caps enforced on register.
    #[test]
    fn test_metadata_size_caps_on_register() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);

        // display_name over 128 bytes.
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "name_too_long"),
            &String::from_str(&env, &"X".repeat(129)),
            &owner,
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::DisplayNameTooLong);

        // too many capabilities (>32).
        let mut caps = Vec::new(&env);
        for _ in 0..33 {
            caps.push_back(String::from_str(&env, "c"));
        }
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "many_caps"),
            &String::from_str(&env, "A"),
            &owner,
            &caps,
        );
        assert_eq!(want_err(res), Error::TooManyCapabilities);

        // a single capability over 32 bytes.
        let mut caps = Vec::new(&env);
        caps.push_back(String::from_str(&env, &"c".repeat(33)));
        let res = client.try_register(
            &owner,
            &String::from_str(&env, "big_cap"),
            &String::from_str(&env, "A"),
            &owner,
            &caps,
        );
        assert_eq!(want_err(res), Error::CapabilityTooLong);
    }

    // F5: caps also enforced on update_metadata.
    #[test]
    fn test_metadata_size_caps_on_update() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        register(&env, &client, &owner, &id, "A");

        let res = client.try_update_metadata(
            &owner,
            &id,
            &String::from_str(&env, &"X".repeat(129)),
            &Vec::new(&env),
        );
        assert_eq!(want_err(res), Error::DisplayNameTooLong);

        let mut caps = Vec::new(&env);
        for _ in 0..33 {
            caps.push_back(String::from_str(&env, "c"));
        }
        let res = client.try_update_metadata(&owner, &id, &String::from_str(&env, "ok"), &caps);
        assert_eq!(want_err(res), Error::TooManyCapabilities);

        // State untouched by the rejected updates.
        let info = client.query(&id).unwrap();
        assert_eq!(info.display_name, String::from_str(&env, "A"));
        assert_eq!(info.capabilities.len(), 0);
    }

    // F5: exactly-at-limit metadata is accepted.
    #[test]
    fn test_metadata_size_at_limits_accepted() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let mut caps = Vec::new(&env);
        for _ in 0..32 {
            caps.push_back(String::from_str(&env, "c"));
        }
        let info = client.register(
            &owner,
            &String::from_str(&env, "limits_ok"),
            &String::from_str(&env, &"d".repeat(128)),
            &owner,
            &caps,
        );
        assert_eq!(info.capabilities.len(), 32);
        assert_eq!(info.display_name.len(), 128);
    }

    // F1: write paths extend the contract INSTANCE ttl — not only the entry.
    #[test]
    fn test_write_extends_instance_ttl() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");

        let inst_before = instance_ttl(&env, &cid);
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        let inst_after = instance_ttl(&env, &cid);
        println!(
            "F1: instance_ttl before={} after_register={}",
            inst_before, inst_after
        );
        assert!(
            inst_after > inst_before,
            "register must extend the contract instance TTL toward max_ttl"
        );

        let entry_before = entry_ttl(&env, &cid, "a1");
        client.update_metadata(&owner, &id, &String::from_str(&env, "B"), &Vec::new(&env));
        let entry_after = entry_ttl(&env, &cid, "a1");
        assert!(entry_after >= entry_before, "update extends entry TTL");
        let inst_after_update = instance_ttl(&env, &cid);
        assert!(
            inst_after_update >= inst_after,
            "update extends instance TTL too"
        );
    }

    // F1: deactivate also extends instance ttl (no write path starves it).
    #[test]
    fn test_deactivate_extends_instance_ttl() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );
        // Age the instance past the extend threshold (max/2) so that a
        // subsequent write's bump_ttl must fire and push the expiration out.
        let threshold = env.storage().max_ttl() / 2;
        let jump = threshold + 10;
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + jump);
        // Measure the *aged* remaining TTL (below threshold) — this is the
        // baseline a write must beat.
        let aged = instance_ttl(&env, &cid);
        client.deactivate(&owner, &id);
        let after = instance_ttl(&env, &cid);
        println!(
            "F1-deact: aged_instance_ttl={} max_ttl={} after_deactivate={}",
            aged,
            env.storage().max_ttl(),
            after
        );
        assert!(
            after > aged,
            "deactivate must extend the aged instance TTL toward max_ttl"
        );
    }

    // F6: query() is a pure read — it mutates no TTL.
    #[test]
    fn test_query_is_pure_read() {
        let (env, cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "a1");
        client.register(
            &owner,
            &id,
            &String::from_str(&env, "A"),
            &owner,
            &Vec::new(&env),
        );

        // Decay BOTH the entry and the instance below the extend threshold
        // (max/2) first. Otherwise the record still sits at max_ttl and a
        // reintroduced bump would be an invisible no-op, letting a regression
        // slip through. This test must fail if `query` mutates any TTL.
        let threshold = env.storage().max_ttl() / 2;
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + threshold + 10);

        let entry_before = entry_ttl(&env, &cid, "a1");
        let inst_before = instance_ttl(&env, &cid);
        assert!(
            entry_before < threshold,
            "test setup: entry must be below the extend threshold (got {})",
            entry_before
        );

        let _ = client.query(&id);
        let _ = client.query(&id);

        let entry_after = entry_ttl(&env, &cid, "a1");
        let inst_after = instance_ttl(&env, &cid);
        println!(
            "F6: entry_ttl {}->{}  instance_ttl {}->{}",
            entry_before, entry_after, inst_before, inst_after
        );
        assert_eq!(
            entry_before, entry_after,
            "query must not mutate the record entry TTL"
        );
        assert_eq!(
            inst_before, inst_after,
            "query must not mutate the contract instance TTL"
        );
    }

    // ---- event emission tests ----

    /// Captures contract events published during execution of `f`.
    fn capture_events<F>(env: &Env, f: F) -> Vec<(Address, Vec<Val>, Val)>
    where
        F: FnOnce(),
    {
        f();
        env.events().all()
    }

    #[test]
    fn test_register_emits_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let stellar_addr = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");

        let events = capture_events(&env, || {
            client.register(
                &owner,
                &id,
                &String::from_str(&env, "Test Agent"),
                &stellar_addr,
                &Vec::new(&env),
            );
        });

        assert_eq!(events.len(), 1, "register should emit exactly one event");
        let (_, topics, data) = events.get(0).unwrap();
        assert_eq!(topics.len(), 2);
        let t0: String = topics.get(0).unwrap().clone().try_into_val(&env).unwrap();
        let t1: String = topics.get(1).unwrap().clone().try_into_val(&env).unwrap();
        assert_eq!(t0, String::from_str(&env, "agent"));
        assert_eq!(t1, String::from_str(&env, "registered"));

        let payload: (String, Address, Address) = data.clone().try_into_val(&env).unwrap();
        assert_eq!(payload.0, id);
        assert_eq!(payload.1, owner);
    }

    #[test]
    fn test_update_metadata_emits_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "Original");

        let events = capture_events(&env, || {
            client.update_metadata(
                &owner,
                &id,
                &String::from_str(&env, "Updated"),
                &Vec::new(&env),
            );
        });

        assert_eq!(
            events.len(),
            1,
            "update_metadata should emit exactly one event"
        );
        let (_, topics, data) = events.get(0).unwrap();
        assert_eq!(topics.len(), 2);
        let t0: String = topics.get(0).unwrap().clone().try_into_val(&env).unwrap();
        let t1: String = topics.get(1).unwrap().clone().try_into_val(&env).unwrap();
        assert_eq!(t0, String::from_str(&env, "agent"));
        assert_eq!(t1, String::from_str(&env, "updated"));

        let payload: (String, Address) = data.clone().try_into_val(&env).unwrap();
        assert_eq!(payload.0, id);
        assert_eq!(payload.1, owner);
    }

    #[test]
    fn test_deactivate_emits_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "Test");

        let events = capture_events(&env, || {
            client.deactivate(&owner, &id);
        });

        assert_eq!(events.len(), 1, "deactivate should emit exactly one event");
        let (_, topics, data) = events.get(0).unwrap();
        assert_eq!(topics.len(), 2);
        let t0: String = topics.get(0).unwrap().clone().try_into_val(&env).unwrap();
        let t1: String = topics.get(1).unwrap().clone().try_into_val(&env).unwrap();
        assert_eq!(t0, String::from_str(&env, "agent"));
        assert_eq!(t1, String::from_str(&env, "deactivated"));

        let payload: (String, Address) = data.clone().try_into_val(&env).unwrap();
        assert_eq!(payload.0, id);
        assert_eq!(payload.1, owner);
    }

    #[test]
    fn test_failed_register_emits_no_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        let events = capture_events(&env, || {
            let res = client.try_register(
                &owner,
                &id,
                &String::from_str(&env, "B"),
                &owner,
                &Vec::new(&env),
            );
            assert!(res.is_err());
        });

        assert!(events.is_empty(), "failed register must not emit an event");
    }

    #[test]
    fn test_failed_update_emits_no_event() {
        let (env, _cid, client) = setup();
        env.mock_all_auths();
        let owner = Address::generate(&env);
        let stranger = Address::generate(&env);
        let id = String::from_str(&env, "agent_1");
        register(&env, &client, &owner, &id, "A");

        env.set_auths(&[]);
        let events = capture_events(&env, || {
            let res = client.try_update_metadata(
                &stranger,
                &id,
                &String::from_str(&env, "Hacked"),
                &Vec::new(&env),
            );
            assert!(res.is_err());
        });

        assert!(events.is_empty(), "failed update must not emit an event");
    }
}
