#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env, String,
};

const MIN: i128 = 50_0000000; // 50 units (7 decimals)
const FEE: i128 = 1_0000000; // 1 unit platform fee
const BPS: u32 = 1000; // 10% of each fee to the treasury
const WATCH: u64 = 7 * 24 * 3600;

fn e(x: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(x as u32)
}

struct T {
    env: Env,
    c: UnveilClient<'static>,
    usdc: TokenClient<'static>,
    admin: Address,
    treasury: Address,
    owner: Address,
    fee_to: Address,
    arb: Address,
    anon: Address,
    req: Address,
    platform: u32,
}

fn setup() -> T {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let owner = Address::generate(&env);
    let fee_to = Address::generate(&env);
    let arb = Address::generate(&env);
    let anon = Address::generate(&env);
    let req = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(&env, &sac.address()).mint(&req, &1_000_0000000);
    let usdc = TokenClient::new(&env, &sac.address());

    let id = env.register(Unveil, (admin.clone(), sac.address(), MIN, WATCH, treasury.clone(), BPS));
    let c = UnveilClient::new(&env, &id);
    let platform = c.register_platform(&owner, &String::from_str(&env, "Test DAO"), &fee_to, &arb, &FEE);
    T { env, c, usdc, admin, treasury, owner, fee_to, arb, anon, req, platform }
}

fn key(env: &Env) -> Bytes {
    let mut k = [7u8; 65];
    k[0] = 4;
    Bytes::from_array(env, &k)
}

fn h(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn wrapped(env: &Env) -> Bytes {
    Bytes::from_array(env, &[9u8; 40])
}

fn open_request(t: &T) -> u64 {
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    t.c.request_reveal(&t.req, &t.anon, &t.platform, &h(&t.env, 2), &key(&t.env), &MIN, &FEE)
}

/// The address whose signature the last call required.
fn signer(t: &T) -> Address {
    let auths = t.env.auths();
    assert_eq!(auths.len(), 1, "expected exactly one signer");
    auths[0].0.clone()
}

// ---------------------------------------------------------------- profiles

#[test]
fn profile_is_stored_with_freshness() {
    let t = setup();
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    let p = t.c.get_profile(&t.anon).unwrap();
    assert_eq!(p.photo_hash, h(&t.env, 1));
    assert_eq!(p.registered_at - p.captured_at, 10);
}

// ---------------------------------------------------------------- platforms

#[test]
fn anyone_can_register_a_platform() {
    let t = setup();
    assert_eq!(t.platform, 0);
    let p = t.c.get_platform(&0);
    assert_eq!(p.owner, t.owner);
    assert_eq!(p.fee_to, t.fee_to);
    assert_eq!(p.arbiter, t.arb);
    assert_eq!(p.fee, FEE);
    assert!(p.arbiter_key.is_empty());

    let other = Address::generate(&t.env);
    let id = t.c.register_platform(&other, &String::from_str(&t.env, "Jobs"), &other, &other, &0);
    assert_eq!(signer(&t), other);
    assert_eq!(id, 1);
    assert_eq!(t.c.platform_count(), 2);
}

#[test]
fn platform_inputs_are_checked() {
    let t = setup();
    let o = Address::generate(&t.env);
    assert_eq!(
        t.c.try_register_platform(&o, &String::from_str(&t.env, "x"), &o, &o, &-1),
        Err(Ok(e(Error::BadFee)))
    );
    assert_eq!(
        t.c.try_register_platform(&o, &String::from_str(&t.env, ""), &o, &o, &0),
        Err(Ok(e(Error::BadName)))
    );
    let long = String::from_str(&t.env, &"x".repeat(65));
    assert_eq!(t.c.try_register_platform(&o, &long, &o, &o, &0), Err(Ok(e(Error::BadName))));
    assert_eq!(t.c.try_get_platform(&9), Err(Ok(e(Error::UnknownPlatform))));
}

#[test]
fn owner_updates_platform_and_new_arbiter_needs_new_key() {
    let t = setup();
    t.c.set_arbiter_key(&t.platform, &key(&t.env));
    assert_eq!(signer(&t), t.arb);
    assert_eq!(t.c.get_platform(&t.platform).arbiter_key, key(&t.env));

    let new_arb = Address::generate(&t.env);
    t.c.update_platform(&t.platform, &t.fee_to, &new_arb, &(FEE * 2));
    assert_eq!(signer(&t), t.owner);
    let p = t.c.get_platform(&t.platform);
    assert_eq!(p.arbiter, new_arb);
    assert_eq!(p.fee, FEE * 2);
    assert!(p.arbiter_key.is_empty(), "old arbiter's key must not carry over");

    // Same arbiter: key is kept.
    t.c.set_arbiter_key(&t.platform, &key(&t.env));
    t.c.update_platform(&t.platform, &t.admin, &new_arb, &FEE);
    assert_eq!(t.c.get_platform(&t.platform).arbiter_key, key(&t.env));
}

#[test]
fn arbiter_key_must_be_uncompressed_p256() {
    let t = setup();
    assert_eq!(
        t.c.try_set_arbiter_key(&t.platform, &Bytes::from_array(&t.env, &[4u8; 33])),
        Err(Ok(e(Error::BadKey)))
    );
    let mut wrong_prefix = [7u8; 65];
    wrong_prefix[0] = 2;
    assert_eq!(
        t.c.try_set_arbiter_key(&t.platform, &Bytes::from_array(&t.env, &wrong_prefix)),
        Err(Ok(e(Error::BadKey)))
    );
}

#[test]
#[should_panic]
fn only_the_platform_arbiter_sets_its_key() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = env.register(Unveil, (admin.clone(), sac.address(), MIN, WATCH, admin.clone(), BPS));
    let c = UnveilClient::new(&env, &id);
    env.mock_all_auths();
    let p = c.register_platform(&admin, &String::from_str(&env, "p"), &admin, &admin, &0);
    env.set_auths(&[]); // nobody has signed now
    c.set_arbiter_key(&p, &key(&env));
}

// ---------------------------------------------------------------- protocol fee

#[test]
fn admin_sets_protocol_fee_within_cap() {
    let t = setup();
    let new_treasury = Address::generate(&t.env);
    t.c.set_protocol_fee(&2500, &new_treasury);
    assert_eq!(signer(&t), t.admin);
    let c = t.c.config();
    assert_eq!(c.protocol_fee_bps, 2500);
    assert_eq!(c.treasury, new_treasury);
    assert_eq!(t.c.try_set_protocol_fee(&3001, &new_treasury), Err(Ok(e(Error::BadFee))));
}

// ---------------------------------------------------------------- reveal flow

#[test]
fn request_locks_deposit_and_fee_and_snapshots_terms() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    assert_eq!(id, 0);
    assert_eq!(t.usdc.balance(&t.c.address), MIN + FEE);
    assert_eq!(t.usdc.balance(&t.req), before - MIN - FEE);
    let r = t.c.get_request(&id);
    assert_eq!(r.status, Status::Pending);
    assert_eq!(r.nda_hash, h(&t.env, 2));
    assert_eq!(r.platform, t.platform);
    assert_eq!(r.fee, FEE);
    assert_eq!(r.arbiter, t.arb);
    assert_eq!(t.c.request_count(), 1);
}

#[test]
fn decline_refunds_deposit_and_fee() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.decline(&t.anon, &id);
    assert_eq!(t.usdc.balance(&t.req), before);
    assert_eq!(t.usdc.balance(&t.fee_to), 0);
    assert_eq!(t.c.get_request(&id).status, Status::Declined);
}

#[test]
fn cancel_refunds_deposit_and_fee() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.cancel(&t.req, &id);
    assert_eq!(t.usdc.balance(&t.req), before);
    assert_eq!(t.c.get_request(&id).status, Status::Cancelled);
}

#[test]
fn approve_pays_the_fee_split() {
    let t = setup();
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    let cut = FEE * BPS as i128 / 10_000;
    assert_eq!(t.usdc.balance(&t.treasury), cut);
    assert_eq!(t.usdc.balance(&t.fee_to), FEE - cut);
    assert_eq!(t.usdc.balance(&t.c.address), MIN, "only the deposit stays locked");
}

#[test]
fn zero_fee_platform_moves_no_fee() {
    let t = setup();
    let free = t.c.register_platform(&t.owner, &String::from_str(&t.env, "Free"), &t.fee_to, &t.arb, &0);
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    let id = t.c.request_reveal(&t.req, &t.anon, &free, &h(&t.env, 2), &key(&t.env), &MIN, &0);
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    assert_eq!(t.usdc.balance(&t.fee_to), 0);
    assert_eq!(t.usdc.balance(&t.treasury), 0);
}

#[test]
fn fee_rise_after_request_does_not_apply() {
    let t = setup();
    let id = open_request(&t);
    t.c.update_platform(&t.platform, &t.fee_to, &t.arb, &(FEE * 10));
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    let cut = FEE * BPS as i128 / 10_000;
    assert_eq!(t.usdc.balance(&t.fee_to), FEE - cut);
}

#[test]
fn max_fee_protects_requester_from_a_fee_hike() {
    let t = setup();
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    t.c.update_platform(&t.platform, &t.fee_to, &t.arb, &(FEE * 10));
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &t.platform, &h(&t.env, 2), &key(&t.env), &MIN, &FEE),
        Err(Ok(e(Error::FeeTooHigh)))
    );
}

#[test]
fn reveal_then_release_after_watch() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    let r = t.c.get_request(&id);
    assert_eq!(r.status, Status::Revealed);
    assert_eq!(r.wrapped_key.len(), 40);

    assert_eq!(t.c.try_release(&t.req, &id), Err(Ok(e(Error::StillLocked))));
    t.env.ledger().set_timestamp(1_000_000 + WATCH);
    t.c.release(&t.req, &id);
    assert_eq!(t.usdc.balance(&t.req), before - FEE, "deposit back, fee spent");
    assert_eq!(t.c.get_request(&id).status, Status::Released);
}

#[test]
fn proven_leak_pays_anon_by_the_requests_arbiter() {
    let t = setup();
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    t.env.ledger().set_timestamp(1_000_000 + 3600);
    t.c.report_leak(&t.anon, &id, &h(&t.env, 3));
    assert_eq!(t.c.get_request(&id).status, Status::Disputed);
    // Requester can't pull the money out mid-dispute.
    t.env.ledger().set_timestamp(1_000_000 + WATCH + 1);
    assert_eq!(t.c.try_release(&t.req, &id), Err(Ok(e(Error::WrongStatus))));

    // The owner swaps the arbiter mid-dispute: the request keeps its original arbiter.
    let friendly = Address::generate(&t.env);
    t.c.update_platform(&t.platform, &t.fee_to, &friendly, &FEE);
    t.c.resolve(&id, &true);
    assert_eq!(signer(&t), t.arb);
    assert_eq!(t.usdc.balance(&t.anon), MIN);
    assert_eq!(t.c.get_request(&id).status, Status::Slashed);
}

#[test]
fn rejected_leak_refunds_requester() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    t.c.report_leak(&t.anon, &id, &h(&t.env, 3));
    t.c.resolve(&id, &false);
    assert_eq!(t.usdc.balance(&t.req), before - FEE);
    assert_eq!(t.c.get_request(&id).status, Status::Cleared);
}

#[test]
fn leak_report_after_window_fails() {
    let t = setup();
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    t.env.ledger().set_timestamp(1_000_000 + WATCH);
    assert_eq!(
        t.c.try_report_leak(&t.anon, &id, &h(&t.env, 3)),
        Err(Ok(e(Error::WindowClosed)))
    );
}

#[test]
fn guards() {
    let t = setup();
    let p = t.platform;
    // No profile yet.
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &p, &h(&t.env, 2), &key(&t.env), &MIN, &FEE),
        Err(Ok(e(Error::NoProfile)))
    );
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    // Unknown platform.
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &7, &h(&t.env, 2), &key(&t.env), &MIN, &FEE),
        Err(Ok(e(Error::UnknownPlatform)))
    );
    // Deposit too small.
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &p, &h(&t.env, 2), &key(&t.env), &(MIN - 1), &FEE),
        Err(Ok(e(Error::DepositTooSmall)))
    );
    // Asking yourself.
    assert_eq!(
        t.c.try_request_reveal(&t.anon, &t.anon, &p, &h(&t.env, 2), &key(&t.env), &MIN, &FEE),
        Err(Ok(e(Error::SelfRequest)))
    );
    // Malformed key.
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &p, &h(&t.env, 2), &Bytes::from_array(&t.env, &[1u8; 33]), &MIN, &FEE),
        Err(Ok(e(Error::BadKey)))
    );
    // Photo from the future.
    assert_eq!(
        t.c.try_set_profile(&t.anon, &h(&t.env, 1), &2_000_000),
        Err(Ok(e(Error::PhotoFromFuture)))
    );
    let id = t.c.request_reveal(&t.req, &t.anon, &p, &h(&t.env, 2), &key(&t.env), &MIN, &FEE);
    // A stranger can't approve someone else's request.
    let stranger = Address::generate(&t.env);
    assert_eq!(t.c.try_approve(&stranger, &id, &wrapped(&t.env)), Err(Ok(e(Error::NotYourRequest))));
    // Can't approve twice.
    t.c.approve(&t.anon, &id, &wrapped(&t.env));
    assert_eq!(t.c.try_approve(&t.anon, &id, &wrapped(&t.env)), Err(Ok(e(Error::WrongStatus))));
}
