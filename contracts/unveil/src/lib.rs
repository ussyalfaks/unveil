//! Unveil — controlled identity reveal for pseudonymous builders, on Stellar.
//!
//! Flow:
//! 1. An anon registers a profile: the SHA-256 of their *encrypted* live photo
//!    plus the time it was captured. The photo itself never touches the chain
//!    or the server in readable form.
//! 2. A requester (DAO, investor, employer) asks to see who the anon is. They
//!    lock a USDC deposit and sign the NDA hash as part of the same
//!    transaction, so the chain holds proof they agreed to it.
//! 3. The anon approves by posting the photo key, encrypted so only that
//!    requester can open it. Or declines, and the deposit goes back.
//! 4. The deposit stays locked for a watch period. Every peek the requester
//!    takes is watermarked with their wallet, so a leak traces back to them.
//!    If the anon reports a leak in that window, an arbiter decides; a proven
//!    leak sends the deposit to the anon. Otherwise the requester withdraws it.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Bytes, BytesN, Env,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NoProfile = 1,
    NoRequest = 2,
    WrongStatus = 3,
    NotYourRequest = 4,
    DepositTooSmall = 5,
    SelfRequest = 6,
    StillLocked = 7,
    WindowClosed = 8,
    BadKey = 9,
    PhotoFromFuture = 10,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    /// Waiting for the anon to approve or decline.
    Pending,
    /// Anon declined; deposit refunded.
    Declined,
    /// Requester withdrew the request before an answer; deposit refunded.
    Cancelled,
    /// Identity revealed; deposit locked during the watch period.
    Revealed,
    /// Watch period ended with no leak report; deposit refunded.
    Released,
    /// Anon reported a leak; waiting for the arbiter.
    Disputed,
    /// Arbiter confirmed the leak; deposit paid to the anon.
    Slashed,
    /// Arbiter rejected the leak report; deposit refunded.
    Cleared,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Profile {
    /// SHA-256 of the encrypted photo blob (lets anyone check the blob wasn't swapped).
    pub photo_hash: BytesN<32>,
    /// When the photo was taken, per the anon's device (unix seconds).
    pub captured_at: u64,
    /// When the profile hit the chain (ledger time). The gap to captured_at
    /// shows how fresh the photo was.
    pub registered_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub id: u64,
    pub requester: Address,
    pub anon: Address,
    /// SHA-256 of the NDA text the requester agreed to.
    pub nda_hash: BytesN<32>,
    /// Requester's P-256 public key (65-byte uncompressed) for key wrapping.
    pub requester_key: Bytes,
    pub deposit: i128,
    pub status: Status,
    pub created_at: u64,
    pub revealed_at: u64,
    /// Photo key encrypted to requester_key (empty until revealed).
    pub wrapped_key: Bytes,
    /// SHA-256 of the anon's leak evidence (all zeros if none).
    pub evidence_hash: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    pub token: Address,
    pub min_deposit: i128,
    /// How long the deposit stays locked after a reveal (seconds).
    pub watch_secs: u64,
}

#[contracttype]
enum Key {
    Config,
    NextId,
    Profile(Address),
    Request(u64),
}

// ---- events (the on-chain audit trail) ----

#[contractevent]
pub struct ProfileSet {
    #[topic]
    pub anon: Address,
    pub photo_hash: BytesN<32>,
    pub captured_at: u64,
}

#[contractevent]
pub struct RevealRequested {
    #[topic]
    pub id: u64,
    #[topic]
    pub anon: Address,
    pub requester: Address,
    pub nda_hash: BytesN<32>,
    pub deposit: i128,
}

#[contractevent]
pub struct StatusChanged {
    #[topic]
    pub id: u64,
    pub status: Status,
    pub at: u64,
}

const DAY: u32 = 17_280; // ledgers (~5s each)
const BUMP_TO: u32 = 90 * DAY;
const BUMP_IF_BELOW: u32 = 30 * DAY;

#[contract]
pub struct Unveil;

fn cfg(env: &Env) -> Config {
    env.storage().instance().get(&Key::Config).unwrap()
}

fn load(env: &Env, id: u64) -> Request {
    env.storage()
        .persistent()
        .get(&Key::Request(id))
        .unwrap_or_else(|| panic_with_error!(env, Error::NoRequest))
}

fn save(env: &Env, r: &Request) {
    let k = Key::Request(r.id);
    env.storage().persistent().set(&k, r);
    env.storage()
        .persistent()
        .extend_ttl(&k, BUMP_IF_BELOW, BUMP_TO);
}

fn set_status(env: &Env, r: &mut Request, s: Status) {
    r.status = s;
    save(env, r);
    StatusChanged {
        id: r.id,
        status: s,
        at: env.ledger().timestamp(),
    }
    .publish(env);
}

fn pay(env: &Env, to: &Address, amount: i128) {
    let c = cfg(env);
    token::TokenClient::new(env, &c.token).transfer(&env.current_contract_address(), to, &amount);
}

fn expect(env: &Env, r: &Request, s: Status) {
    if r.status != s {
        panic_with_error!(env, Error::WrongStatus);
    }
}

#[contractimpl]
impl Unveil {
    pub fn __constructor(env: Env, admin: Address, token: Address, min_deposit: i128, watch_secs: u64) {
        env.storage().instance().set(
            &Key::Config,
            &Config {
                admin,
                token,
                min_deposit,
                watch_secs,
            },
        );
        env.storage().instance().set(&Key::NextId, &0u64);
    }

    // ---------- anon ----------

    /// Register or replace the anon's encrypted photo commitment.
    pub fn set_profile(env: Env, anon: Address, photo_hash: BytesN<32>, captured_at: u64) {
        anon.require_auth();
        let now = env.ledger().timestamp();
        // Allow a little clock skew, but no photos from the future.
        if captured_at > now + 300 {
            panic_with_error!(&env, Error::PhotoFromFuture);
        }
        let k = Key::Profile(anon.clone());
        env.storage().persistent().set(
            &k,
            &Profile {
                photo_hash: photo_hash.clone(),
                captured_at,
                registered_at: now,
            },
        );
        env.storage()
            .persistent()
            .extend_ttl(&k, BUMP_IF_BELOW, BUMP_TO);
        ProfileSet {
            anon,
            photo_hash,
            captured_at,
        }
        .publish(&env);
    }

    /// Approve: post the photo key, encrypted so only the requester can open it.
    pub fn approve(env: Env, anon: Address, id: u64, wrapped_key: Bytes) {
        anon.require_auth();
        let mut r = load(&env, id);
        if r.anon != anon {
            panic_with_error!(&env, Error::NotYourRequest);
        }
        expect(&env, &r, Status::Pending);
        if wrapped_key.is_empty() {
            panic_with_error!(&env, Error::BadKey);
        }
        r.wrapped_key = wrapped_key;
        r.revealed_at = env.ledger().timestamp();
        set_status(&env, &mut r, Status::Revealed);
    }

    /// Decline: deposit goes straight back to the requester.
    pub fn decline(env: Env, anon: Address, id: u64) {
        anon.require_auth();
        let mut r = load(&env, id);
        if r.anon != anon {
            panic_with_error!(&env, Error::NotYourRequest);
        }
        expect(&env, &r, Status::Pending);
        pay(&env, &r.requester, r.deposit);
        set_status(&env, &mut r, Status::Declined);
    }

    /// Report a leak during the watch period. Freezes the deposit for the arbiter.
    pub fn report_leak(env: Env, anon: Address, id: u64, evidence_hash: BytesN<32>) {
        anon.require_auth();
        let mut r = load(&env, id);
        if r.anon != anon {
            panic_with_error!(&env, Error::NotYourRequest);
        }
        expect(&env, &r, Status::Revealed);
        if env.ledger().timestamp() >= r.revealed_at + cfg(&env).watch_secs {
            panic_with_error!(&env, Error::WindowClosed);
        }
        r.evidence_hash = evidence_hash;
        set_status(&env, &mut r, Status::Disputed);
    }

    // ---------- requester ----------

    /// Ask to see who `anon` is. Locks `deposit` and records the NDA the
    /// requester is signing with this very transaction.
    pub fn request_reveal(
        env: Env,
        requester: Address,
        anon: Address,
        nda_hash: BytesN<32>,
        requester_key: Bytes,
        deposit: i128,
    ) -> u64 {
        requester.require_auth();
        if requester == anon {
            panic_with_error!(&env, Error::SelfRequest);
        }
        if !env.storage().persistent().has(&Key::Profile(anon.clone())) {
            panic_with_error!(&env, Error::NoProfile);
        }
        let c = cfg(&env);
        if deposit < c.min_deposit {
            panic_with_error!(&env, Error::DepositTooSmall);
        }
        // Uncompressed P-256 point: 0x04 || X || Y
        if requester_key.len() != 65 || requester_key.get(0) != Some(4) {
            panic_with_error!(&env, Error::BadKey);
        }
        token::TokenClient::new(&env, &c.token).transfer(
            &requester,
            &env.current_contract_address(),
            &deposit,
        );

        let id: u64 = env.storage().instance().get(&Key::NextId).unwrap();
        env.storage().instance().set(&Key::NextId, &(id + 1));
        env.storage()
            .instance()
            .extend_ttl(BUMP_IF_BELOW, BUMP_TO);

        let r = Request {
            id,
            requester: requester.clone(),
            anon: anon.clone(),
            nda_hash: nda_hash.clone(),
            requester_key,
            deposit,
            status: Status::Pending,
            created_at: env.ledger().timestamp(),
            revealed_at: 0,
            wrapped_key: Bytes::new(&env),
            evidence_hash: BytesN::from_array(&env, &[0; 32]),
        };
        save(&env, &r);
        RevealRequested {
            id,
            anon,
            requester,
            nda_hash,
            deposit,
        }
        .publish(&env);
        id
    }

    /// Withdraw a request the anon hasn't answered yet.
    pub fn cancel(env: Env, requester: Address, id: u64) {
        requester.require_auth();
        let mut r = load(&env, id);
        if r.requester != requester {
            panic_with_error!(&env, Error::NotYourRequest);
        }
        expect(&env, &r, Status::Pending);
        pay(&env, &r.requester, r.deposit);
        set_status(&env, &mut r, Status::Cancelled);
    }

    /// After the watch period with no leak report, take the deposit back.
    pub fn release(env: Env, requester: Address, id: u64) {
        requester.require_auth();
        let mut r = load(&env, id);
        if r.requester != requester {
            panic_with_error!(&env, Error::NotYourRequest);
        }
        expect(&env, &r, Status::Revealed);
        if env.ledger().timestamp() < r.revealed_at + cfg(&env).watch_secs {
            panic_with_error!(&env, Error::StillLocked);
        }
        pay(&env, &r.requester, r.deposit);
        set_status(&env, &mut r, Status::Released);
    }

    // ---------- arbiter ----------

    /// Decide a leak report. `leaked = true` pays the deposit to the anon.
    pub fn resolve(env: Env, id: u64, leaked: bool) {
        cfg(&env).admin.require_auth();
        let mut r = load(&env, id);
        expect(&env, &r, Status::Disputed);
        if leaked {
            pay(&env, &r.anon, r.deposit);
            set_status(&env, &mut r, Status::Slashed);
        } else {
            pay(&env, &r.requester, r.deposit);
            set_status(&env, &mut r, Status::Cleared);
        }
    }

    // ---------- reads ----------

    pub fn get_profile(env: Env, anon: Address) -> Option<Profile> {
        env.storage().persistent().get(&Key::Profile(anon))
    }

    pub fn get_request(env: Env, id: u64) -> Request {
        load(&env, id)
    }

    pub fn request_count(env: Env) -> u64 {
        env.storage().instance().get(&Key::NextId).unwrap()
    }

    pub fn config(env: Env) -> Config {
        cfg(&env)
    }
}

#[cfg(test)]
mod test;
