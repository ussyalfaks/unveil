//! Unveil — controlled identity reveal for pseudonymous builders, on Stellar.
//!
//! Flow:
//! 1. An anon registers a profile: the SHA-256 of their *encrypted* live photo
//!    plus the time it was captured. The photo itself never touches the chain
//!    or the server in readable form.
//! 2. A requester (DAO, investor, employer) asks to see who the anon is,
//!    through a platform. They lock a deposit plus the platform's fee and sign
//!    the NDA hash in the same transaction, so the chain holds proof they
//!    agreed to it.
//! 3. The anon approves by posting the photo key, encrypted so only that
//!    requester can open it; the fee is then paid to the platform (minus the
//!    protocol's cut). Or the anon declines, and deposit + fee go back.
//! 4. The deposit stays locked for a watch period. Every peek the requester
//!    takes is watermarked with their wallet, so a leak traces back to them.
//!    If the anon reports a leak in that window, the platform's arbiter
//!    decides; a proven leak sends the deposit to the anon. Otherwise the
//!    requester withdraws it.
//!
//! Platforms are permissionless: anyone can register one with its own fee,
//! payout address and arbiter. Each request records the fee and arbiter in
//! force when it was made, so a platform owner can't change them mid-flight.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, Bytes, BytesN, Env, String,
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
    UnknownPlatform = 11,
    /// The platform's fee is above the requester's `max_fee`.
    FeeTooHigh = 12,
    BadFee = 13,
    BadName = 14,
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
    /// Platform the request came through.
    pub platform: u32,
    /// Platform fee locked with the deposit; paid out on approval.
    pub fee: i128,
    /// Who settles a dispute on this request (the platform's arbiter at request time).
    pub arbiter: Address,
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
    /// Receives the protocol's cut of every platform fee.
    pub treasury: Address,
    /// The protocol's cut, in basis points of the fee (1000 = 10%).
    pub protocol_fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Platform {
    pub id: u32,
    pub name: String,
    /// Can change fee_to, arbiter and fee.
    pub owner: Address,
    /// Receives the platform's share of fees.
    pub fee_to: Address,
    /// Settles disputes on requests made through this platform.
    pub arbiter: Address,
    /// Arbiter's P-256 public key (65-byte uncompressed). Leak evidence is
    /// encrypted to it. Empty until the arbiter sets it.
    pub arbiter_key: Bytes,
    /// Charged per reveal, in the deposit token's smallest unit.
    pub fee: i128,
}

#[contracttype]
enum Key {
    Config,
    NextId,
    NextPlatform,
    Profile(Address),
    Request(u64),
    Platform(u32),
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
    pub platform: u32,
    pub nda_hash: BytesN<32>,
    pub deposit: i128,
    pub fee: i128,
}

#[contractevent]
pub struct PlatformSet {
    #[topic]
    pub id: u32,
    pub owner: Address,
    pub fee_to: Address,
    pub arbiter: Address,
    pub fee: i128,
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
/// The protocol can never take more than 30% of a platform's fee.
const MAX_PROTOCOL_BPS: u32 = 3000;
const MAX_NAME: u32 = 64;

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
    if amount <= 0 {
        return;
    }
    let c = cfg(env);
    token::TokenClient::new(env, &c.token).transfer(&env.current_contract_address(), to, &amount);
}

fn load_platform(env: &Env, id: u32) -> Platform {
    env.storage()
        .persistent()
        .get(&Key::Platform(id))
        .unwrap_or_else(|| panic_with_error!(env, Error::UnknownPlatform))
}

fn save_platform(env: &Env, p: &Platform) {
    let k = Key::Platform(p.id);
    env.storage().persistent().set(&k, p);
    env.storage()
        .persistent()
        .extend_ttl(&k, BUMP_IF_BELOW, BUMP_TO);
    PlatformSet {
        id: p.id,
        owner: p.owner.clone(),
        fee_to: p.fee_to.clone(),
        arbiter: p.arbiter.clone(),
        fee: p.fee,
    }
    .publish(env);
}

fn check_fee(env: &Env, fee: i128) {
    if fee < 0 {
        panic_with_error!(env, Error::BadFee);
    }
}

fn check_key(env: &Env, key: &Bytes) {
    // Uncompressed P-256 point: 0x04 || X || Y
    if key.len() != 65 || key.get(0) != Some(4) {
        panic_with_error!(env, Error::BadKey);
    }
}

fn expect(env: &Env, r: &Request, s: Status) {
    if r.status != s {
        panic_with_error!(env, Error::WrongStatus);
    }
}

#[contractimpl]
impl Unveil {
    pub fn __constructor(
        env: Env,
        admin: Address,
        token: Address,
        min_deposit: i128,
        watch_secs: u64,
        treasury: Address,
        protocol_fee_bps: u32,
    ) {
        if protocol_fee_bps > MAX_PROTOCOL_BPS {
            panic_with_error!(&env, Error::BadFee);
        }
        env.storage().instance().set(
            &Key::Config,
            &Config {
                admin,
                token,
                min_deposit,
                watch_secs,
                treasury,
                protocol_fee_bps,
            },
        );
        env.storage().instance().set(&Key::NextId, &0u64);
        env.storage().instance().set(&Key::NextPlatform, &0u32);
    }

    // ---------- platforms ----------

    /// Register a platform. Anyone can; the caller becomes its owner.
    pub fn register_platform(env: Env, owner: Address, name: String, fee_to: Address, arbiter: Address, fee: i128) -> u32 {
        owner.require_auth();
        if name.len() == 0 || name.len() > MAX_NAME {
            panic_with_error!(&env, Error::BadName);
        }
        check_fee(&env, fee);
        let id: u32 = env.storage().instance().get(&Key::NextPlatform).unwrap();
        env.storage().instance().set(&Key::NextPlatform, &(id + 1));
        env.storage()
            .instance()
            .extend_ttl(BUMP_IF_BELOW, BUMP_TO);
        save_platform(
            &env,
            &Platform {
                id,
                name,
                owner,
                fee_to,
                arbiter,
                arbiter_key: Bytes::new(&env),
                fee,
            },
        );
        id
    }

    /// Owner only. A new arbiter starts without an evidence key.
    pub fn update_platform(env: Env, id: u32, fee_to: Address, arbiter: Address, fee: i128) {
        let mut p = load_platform(&env, id);
        p.owner.require_auth();
        check_fee(&env, fee);
        if p.arbiter != arbiter {
            p.arbiter_key = Bytes::new(&env);
        }
        p.fee_to = fee_to;
        p.arbiter = arbiter;
        p.fee = fee;
        save_platform(&env, &p);
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
        // The reveal happened: pay the fee, protocol cut first.
        let c = cfg(&env);
        let cut = r.fee * c.protocol_fee_bps as i128 / 10_000;
        pay(&env, &c.treasury, cut);
        pay(&env, &load_platform(&env, r.platform).fee_to, r.fee - cut);
        set_status(&env, &mut r, Status::Revealed);
    }

    /// Decline: deposit and fee go straight back to the requester.
    pub fn decline(env: Env, anon: Address, id: u64) {
        anon.require_auth();
        let mut r = load(&env, id);
        if r.anon != anon {
            panic_with_error!(&env, Error::NotYourRequest);
        }
        expect(&env, &r, Status::Pending);
        pay(&env, &r.requester, r.deposit + r.fee);
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

    /// Ask to see who `anon` is, through `platform`. Locks `deposit` plus the
    /// platform's fee and records the NDA the requester is signing with this
    /// very transaction. `max_fee` guards against a fee rise just before.
    pub fn request_reveal(
        env: Env,
        requester: Address,
        anon: Address,
        platform: u32,
        nda_hash: BytesN<32>,
        requester_key: Bytes,
        deposit: i128,
        max_fee: i128,
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
        check_key(&env, &requester_key);
        let p = load_platform(&env, platform);
        if p.fee > max_fee {
            panic_with_error!(&env, Error::FeeTooHigh);
        }
        token::TokenClient::new(&env, &c.token).transfer(
            &requester,
            &env.current_contract_address(),
            &(deposit + p.fee),
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
            platform,
            fee: p.fee,
            arbiter: p.arbiter.clone(),
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
            platform,
            nda_hash,
            deposit,
            fee: p.fee,
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
        pay(&env, &r.requester, r.deposit + r.fee);
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

    /// Publish the key that leak evidence for this platform is encrypted to.
    /// Kept on-chain so a storage server can't swap in its own key.
    pub fn set_arbiter_key(env: Env, platform: u32, key: Bytes) {
        let mut p = load_platform(&env, platform);
        p.arbiter.require_auth();
        check_key(&env, &key);
        p.arbiter_key = key;
        save_platform(&env, &p);
    }

    /// Decide a leak report. Only the arbiter recorded on the request can.
    /// `leaked = true` pays the deposit to the anon.
    pub fn resolve(env: Env, id: u64, leaked: bool) {
        let mut r = load(&env, id);
        r.arbiter.require_auth();
        expect(&env, &r, Status::Disputed);
        if leaked {
            pay(&env, &r.anon, r.deposit);
            set_status(&env, &mut r, Status::Slashed);
        } else {
            pay(&env, &r.requester, r.deposit);
            set_status(&env, &mut r, Status::Cleared);
        }
    }

    // ---------- admin ----------

    /// Change the protocol's cut (max 30%) and where it goes.
    pub fn set_protocol_fee(env: Env, bps: u32, treasury: Address) {
        let mut c = cfg(&env);
        c.admin.require_auth();
        if bps > MAX_PROTOCOL_BPS {
            panic_with_error!(&env, Error::BadFee);
        }
        c.protocol_fee_bps = bps;
        c.treasury = treasury;
        env.storage().instance().set(&Key::Config, &c);
    }

    // ---------- reads ----------

    pub fn get_platform(env: Env, id: u32) -> Platform {
        load_platform(&env, id)
    }

    pub fn platform_count(env: Env) -> u32 {
        env.storage().instance().get(&Key::NextPlatform).unwrap()
    }

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
