#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env,
};

const MIN: i128 = 50_0000000; // 50 USDC (7 decimals)
const WATCH: u64 = 7 * 24 * 3600;

fn e(x: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(x as u32)
}

struct T {
    env: Env,
    c: UnveilClient<'static>,
    usdc: TokenClient<'static>,
    admin: Address,
    anon: Address,
    req: Address,
}

fn setup() -> T {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(1_000_000);

    let admin = Address::generate(&env);
    let anon = Address::generate(&env);
    let req = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    StellarAssetClient::new(&env, &sac.address()).mint(&req, &1_000_0000000);
    let usdc = TokenClient::new(&env, &sac.address());

    let id = env.register(Unveil, (admin.clone(), sac.address(), MIN, WATCH));
    let c = UnveilClient::new(&env, &id);
    T { env, c, usdc, admin, anon, req }
}

fn key(env: &Env) -> Bytes {
    let mut k = [7u8; 65];
    k[0] = 4;
    Bytes::from_array(env, &k)
}

fn h(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn open_request(t: &T) -> u64 {
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    t.c.request_reveal(&t.req, &t.anon, &h(&t.env, 2), &key(&t.env), &MIN)
}

#[test]
fn profile_is_stored_with_freshness() {
    let t = setup();
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    let p = t.c.get_profile(&t.anon).unwrap();
    assert_eq!(p.photo_hash, h(&t.env, 1));
    assert_eq!(p.registered_at - p.captured_at, 10);
}

#[test]
fn request_locks_deposit_and_records_nda() {
    let t = setup();
    let id = open_request(&t);
    assert_eq!(id, 0);
    assert_eq!(t.usdc.balance(&t.c.address), MIN);
    let r = t.c.get_request(&id);
    assert_eq!(r.status, Status::Pending);
    assert_eq!(r.nda_hash, h(&t.env, 2));
    assert_eq!(t.c.request_count(), 1);
}

#[test]
fn decline_refunds() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.decline(&t.anon, &id);
    assert_eq!(t.usdc.balance(&t.req), before);
    assert_eq!(t.c.get_request(&id).status, Status::Declined);
}

#[test]
fn cancel_refunds() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.cancel(&t.req, &id);
    assert_eq!(t.usdc.balance(&t.req), before);
    assert_eq!(t.c.get_request(&id).status, Status::Cancelled);
}

#[test]
fn reveal_then_release_after_watch() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &Bytes::from_array(&t.env, &[9u8; 40]));
    let r = t.c.get_request(&id);
    assert_eq!(r.status, Status::Revealed);
    assert_eq!(r.wrapped_key.len(), 40);

    // Too early.
    assert_eq!(
        t.c.try_release(&t.req, &id),
        Err(Ok(e(Error::StillLocked)))
    );
    t.env.ledger().set_timestamp(1_000_000 + WATCH);
    t.c.release(&t.req, &id);
    assert_eq!(t.usdc.balance(&t.req), before);
    assert_eq!(t.c.get_request(&id).status, Status::Released);
}

#[test]
fn proven_leak_pays_anon() {
    let t = setup();
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &Bytes::from_array(&t.env, &[9u8; 40]));
    t.env.ledger().set_timestamp(1_000_000 + 3600);
    t.c.report_leak(&t.anon, &id, &h(&t.env, 3));
    assert_eq!(t.c.get_request(&id).status, Status::Disputed);
    // Requester can't pull the money out mid-dispute.
    t.env.ledger().set_timestamp(1_000_000 + WATCH + 1);
    assert_eq!(t.c.try_release(&t.req, &id), Err(Ok(e(Error::WrongStatus))));

    t.c.resolve(&id, &true);
    assert_eq!(t.usdc.balance(&t.anon), MIN);
    assert_eq!(t.c.get_request(&id).status, Status::Slashed);
}

#[test]
fn rejected_leak_refunds_requester() {
    let t = setup();
    let before = t.usdc.balance(&t.req);
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &Bytes::from_array(&t.env, &[9u8; 40]));
    t.c.report_leak(&t.anon, &id, &h(&t.env, 3));
    t.c.resolve(&id, &false);
    assert_eq!(t.usdc.balance(&t.req), before);
    assert_eq!(t.c.get_request(&id).status, Status::Cleared);
}

#[test]
fn leak_report_after_window_fails() {
    let t = setup();
    let id = open_request(&t);
    t.c.approve(&t.anon, &id, &Bytes::from_array(&t.env, &[9u8; 40]));
    t.env.ledger().set_timestamp(1_000_000 + WATCH);
    assert_eq!(
        t.c.try_report_leak(&t.anon, &id, &h(&t.env, 3)),
        Err(Ok(e(Error::WindowClosed)))
    );
}

#[test]
fn guards() {
    let t = setup();
    // No profile yet.
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &h(&t.env, 2), &key(&t.env), &MIN),
        Err(Ok(e(Error::NoProfile)))
    );
    t.c.set_profile(&t.anon, &h(&t.env, 1), &999_990);
    // Deposit too small.
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &h(&t.env, 2), &key(&t.env), &(MIN - 1)),
        Err(Ok(e(Error::DepositTooSmall)))
    );
    // Asking yourself.
    assert_eq!(
        t.c.try_request_reveal(&t.anon, &t.anon, &h(&t.env, 2), &key(&t.env), &MIN),
        Err(Ok(e(Error::SelfRequest)))
    );
    // Malformed key.
    assert_eq!(
        t.c.try_request_reveal(&t.req, &t.anon, &h(&t.env, 2), &Bytes::from_array(&t.env, &[1u8; 33]), &MIN),
        Err(Ok(e(Error::BadKey)))
    );
    // Photo from the future.
    assert_eq!(
        t.c.try_set_profile(&t.anon, &h(&t.env, 1), &2_000_000),
        Err(Ok(e(Error::PhotoFromFuture)))
    );
    let id = t.c.request_reveal(&t.req, &t.anon, &h(&t.env, 2), &key(&t.env), &MIN);
    // A stranger can't approve someone else's request.
    let stranger = Address::generate(&t.env);
    assert_eq!(
        t.c.try_approve(&stranger, &id, &Bytes::from_array(&t.env, &[9u8; 40])),
        Err(Ok(e(Error::NotYourRequest)))
    );
    // Can't approve twice.
    t.c.approve(&t.anon, &id, &Bytes::from_array(&t.env, &[9u8; 40]));
    assert_eq!(
        t.c.try_approve(&t.anon, &id, &Bytes::from_array(&t.env, &[9u8; 40])),
        Err(Ok(e(Error::WrongStatus)))
    );
    let _ = &t.admin;
}

#[test]
fn admin_sets_arbiter_key() {
    let t = setup();
    assert!(t.c.config().arbiter_key.is_empty());
    t.c.set_arbiter_key(&key(&t.env));
    // Only the admin's signature was asked for.
    let auths = t.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, t.admin);
    assert_eq!(t.c.config().arbiter_key, key(&t.env));
}

#[test]
fn arbiter_key_must_be_uncompressed_p256() {
    let t = setup();
    assert_eq!(
        t.c.try_set_arbiter_key(&Bytes::from_array(&t.env, &[4u8; 33])),
        Err(Ok(e(Error::BadKey)))
    );
    let mut wrong_prefix = [7u8; 65];
    wrong_prefix[0] = 2;
    assert_eq!(
        t.c.try_set_arbiter_key(&Bytes::from_array(&t.env, &wrong_prefix)),
        Err(Ok(e(Error::BadKey)))
    );
}

#[test]
#[should_panic]
fn only_admin_sets_arbiter_key() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let id = env.register(Unveil, (admin, sac.address(), MIN, WATCH));
    // No auth mocked: the admin hasn't signed, so this must fail.
    UnveilClient::new(&env, &id).set_arbiter_key(&key(&env));
}
