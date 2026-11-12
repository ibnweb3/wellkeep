use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const HH: u32 = 12;
const SLOTS: u8 = 4;
const SEC: u64 = 1_000_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn code(hh: u32, slot: u8, action: u8) -> String {
    format!("c{hh}-{slot}-{action}")
}

fn leaf(hh: u32, slot: u8, action: u8) -> [u8; 32] {
    let mut d = b"bh1".to_vec();
    d.extend_from_slice(&hh.to_le_bytes());
    d.push(slot);
    d.push(action);
    d.extend_from_slice(code(hh, slot, action).as_bytes());
    env::sha256_array(&d)
}

fn pair(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(&lo);
    buf[32..].copy_from_slice(&hi);
    env::sha256_array(&buf)
}

/// Builds the tree over every (hh, slot, action) leaf. Returns root and a proof lookup.
struct Tree {
    levels: Vec<Vec<[u8; 32]>>,
}

impl Tree {
    fn new() -> Self {
        let mut leaves = vec![];
        for hh in 0..HH {
            for slot in 0..SLOTS {
                for a in 0..3u8 {
                    leaves.push(leaf(hh, slot, a));
                }
            }
        }
        let mut levels = vec![leaves];
        while levels.last().unwrap().len() > 1 {
            let cur = levels.last().unwrap();
            let mut next = vec![];
            for ch in cur.chunks(2) {
                next.push(if ch.len() == 2 { pair(ch[0], ch[1]) } else { ch[0] });
            }
            levels.push(next);
        }
        Self { levels }
    }
    fn root(&self) -> [u8; 32] {
        self.levels.last().unwrap()[0]
    }
    fn cred(&self, hh: u32, slot: u8, action: u8) -> Credential {
        let mut idx = ((hh as usize) * SLOTS as usize + slot as usize) * 3 + action as usize;
        let mut proof = vec![];
        for level in &self.levels[..self.levels.len() - 1] {
            let sib = idx ^ 1;
            if sib < level.len() {
                proof.push(Base64VecU8::from(level[sib].to_vec()));
            }
            idx /= 2;
        }
        Credential { batch: 0, hh, slot, code: code(hh, slot, action), proof }
    }
}

fn params() -> Params {
    Params {
        hold_ns: U64(100 * SEC),
        vote_window_ns: U64(50 * SEC),
        min_replies: 3,
        sample_size: 4,
        max_price: U128(10_000),
        first_pct: 70,
        rebroken_needed: 2,
        max_attempts: 2,
    }
}

fn ctx(who: &str, deposit: u128, t: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct("pool.testnet"))
        .predecessor_account_id(acct(who))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(t)
        .random_seed([7u8; 32])
        .build());
}

fn setup() -> (Contract, Tree) {
    ctx("a.testnet", 0, 0);
    let tree = Tree::new();
    let mut c = Contract::build([acct("a.testnet"), acct("b.testnet")], params(), tree.root().to_vec(), HH);
    for act in [
        Action::AddMechanic { account: acct("mech.testnet") },
        Action::AddPump { name: "Well 1".into() },
        Action::AddPump { name: "Well 2".into() },
    ] {
        ctx("a.testnet", 0, 0);
        assert!(!c.approve_action(act.clone()));
        ctx("b.testnet", 0, 0);
        assert!(c.approve_action(act));
    }
    ctx("donor.testnet", 100_000, 0);
    c.fund(None);
    (c, tree)
}

/// Report, accept, post fix and return the job id plus the households asked.
fn to_voting(c: &mut Contract, t: &Tree, slot: u8, now: u64) -> (u64, Vec<u32>) {
    ctx("relay.testnet", 0, now);
    let id = c.report_broken(0, t.cred(0, slot, ACT_REPORT));
    ctx("mech.testnet", 0, now);
    c.accept_job(id, U128(1_000));
    c.post_fix(id);
    let j = c.get_job(id).unwrap();
    (id, j.eligible)
}

#[test]
fn fund_goes_to_pool_or_pump() {
    let (mut c, _) = setup();
    ctx("donor.testnet", 500, 0);
    c.fund(Some(1));
    let cfg = c.get_config();
    assert_eq!(cfg.free.0, 100_000);
    assert_eq!(c.get_pump(1).unwrap().earmark.0, 500);
    assert_eq!(c.list_ledger(0, 10).len(), 2);
}

#[test]
fn full_flow_pays_70_then_30() {
    let (mut c, t) = setup();
    let (id, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    assert!(asked.contains(&0));
    assert_eq!(asked.len(), 5); // reporter + 4 sampled
    // three yes votes reach min_replies = 3 and approve
    let mut n = 0;
    for hh in asked.iter().copied() {
        ctx("relay.testnet", 0, 20 * SEC);
        let slot = if hh == 0 { 1 } else { 0 };
        c.vote(id, true, t.cred(hh, slot, ACT_YES));
        n += 1;
        if n == 3 {
            break;
        }
    }
    let j = c.get_job(id).unwrap();
    assert_eq!(j.status, Status::Approved);
    assert_eq!(j.paid.0, 700);
    assert_eq!(j.held.0, 300);
    ctx("anyone.testnet", 0, 20 * SEC + 100 * SEC);
    c.release_held(id);
    let j = c.get_job(id).unwrap();
    assert_eq!(j.status, Status::Completed);
    assert_eq!(j.paid.0, 1_000);
    assert_eq!(c.get_config().free.0, 99_000);
}

#[test]
#[should_panic(expected = "hold period not over")]
fn held_share_cannot_be_released_early() {
    let (mut c, t) = setup();
    let (id, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    for hh in asked.iter().copied().take(3) {
        ctx("relay.testnet", 0, 20 * SEC);
        c.vote(id, true, t.cred(hh, if hh == 0 { 1 } else { 0 }, ACT_YES));
    }
    ctx("anyone.testnet", 0, 30 * SEC);
    c.release_held(id);
}

#[test]
fn two_rebroken_reports_forfeit_the_held_share() {
    let (mut c, t) = setup();
    let (id, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    for hh in asked.iter().copied().take(3) {
        ctx("relay.testnet", 0, 20 * SEC);
        c.vote(id, true, t.cred(hh, if hh == 0 { 1 } else { 0 }, ACT_YES));
    }
    ctx("relay.testnet", 0, 30 * SEC);
    c.report_broken(0, t.cred(1, 3, ACT_REPORT));
    assert_eq!(c.get_job(id).unwrap().status, Status::Approved);
    ctx("relay.testnet", 0, 31 * SEC);
    c.report_broken(0, t.cred(2, 3, ACT_REPORT));
    let j = c.get_job(id).unwrap();
    assert_eq!(j.status, Status::Forfeited);
    assert_eq!(j.held.0, 0);
    // the 300 went back to the fund; a new job is open for the pump
    assert_eq!(c.get_config().free.0, 99_300);
    assert!(c.get_pump(0).unwrap().held_job.is_none());
    assert!(c.get_pump(0).unwrap().open_job.is_some());
}

#[test]
fn majority_no_rejects_then_disputes() {
    let (mut c, t) = setup();
    let (id, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    for hh in asked.iter().copied().take(3) {
        ctx("relay.testnet", 0, 20 * SEC);
        c.vote(id, false, t.cred(hh, if hh == 0 { 1 } else { 0 }, ACT_NO));
    }
    assert_eq!(c.get_job(id).unwrap().status, Status::Accepted);
    ctx("mech.testnet", 0, 30 * SEC);
    c.post_fix(id);
    let asked = c.get_job(id).unwrap().eligible;
    for hh in asked.iter().copied().take(3) {
        ctx("relay.testnet", 0, 40 * SEC);
        let slot = if hh == 0 { 2 } else { 1 };
        c.vote(id, false, t.cred(hh, slot, ACT_NO));
    }
    assert_eq!(c.get_job(id).unwrap().status, Status::Disputed);
    // both signers cancel; the reserved price returns to the fund
    for s in ["a.testnet", "b.testnet"] {
        ctx(s, 0, 50 * SEC);
        c.approve_action(Action::CancelJob { job: id });
    }
    assert_eq!(c.get_job(id).unwrap().status, Status::Cancelled);
    assert_eq!(c.get_config().free.0, 100_000);
}

#[test]
#[should_panic(expected = "code slot already used")]
fn one_time_code_cannot_be_reused() {
    let (mut c, t) = setup();
    ctx("relay.testnet", 0, 0);
    c.report_broken(0, t.cred(0, 0, ACT_REPORT));
    c.report_broken(0, t.cred(0, 0, ACT_REPORT));
}

#[test]
#[should_panic(expected = "invalid code")]
fn wrong_code_is_rejected() {
    let (mut c, t) = setup();
    ctx("relay.testnet", 0, 0);
    let mut cred = t.cred(0, 0, ACT_REPORT);
    cred.code = "guess".into();
    c.report_broken(0, cred);
}

#[test]
#[should_panic(expected = "invalid code")]
fn a_yes_code_cannot_be_used_as_a_report() {
    let (mut c, t) = setup();
    ctx("relay.testnet", 0, 0);
    let mut cred = t.cred(0, 0, ACT_YES);
    cred.code = code(0, 0, ACT_YES);
    c.report_broken(0, cred);
}

#[test]
#[should_panic(expected = "not asked about this job")]
fn household_outside_the_sample_cannot_vote() {
    let (mut c, t) = setup();
    let (id, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    let outsider = (0..HH).find(|h| !asked.contains(h)).expect("someone was not asked");
    ctx("relay.testnet", 0, 20 * SEC);
    c.vote(id, true, t.cred(outsider, 0, ACT_YES));
}

#[test]
#[should_panic(expected = "not a registered mechanic")]
fn unregistered_mechanic_cannot_accept() {
    let (mut c, t) = setup();
    ctx("relay.testnet", 0, 0);
    let id = c.report_broken(0, t.cred(0, 0, ACT_REPORT));
    ctx("stranger.testnet", 0, 0);
    c.accept_job(id, U128(100));
}

#[test]
#[should_panic(expected = "price outside the allowed range")]
fn price_above_cap_is_rejected() {
    let (mut c, t) = setup();
    ctx("relay.testnet", 0, 0);
    let id = c.report_broken(0, t.cred(0, 0, ACT_REPORT));
    ctx("mech.testnet", 0, 0);
    c.accept_job(id, U128(10_001));
}

#[test]
#[should_panic(expected = "fund cannot cover this price")]
fn price_above_fund_is_rejected() {
    let (_c, t) = setup();
    // a fresh contract with no money in it
    let mut empty = Contract::build([acct("a.testnet"), acct("b.testnet")], params(), t.root().to_vec(), HH);
    for act in [Action::AddMechanic { account: acct("mech.testnet") }, Action::AddPump { name: "W".into() }] {
        ctx("a.testnet", 0, 0);
        empty.approve_action(act.clone());
        ctx("b.testnet", 0, 0);
        empty.approve_action(act);
    }
    ctx("relay.testnet", 0, 0);
    let id = empty.report_broken(0, t.cred(0, 0, ACT_REPORT));
    ctx("mech.testnet", 0, 0);
    empty.accept_job(id, U128(100));
}

#[test]
#[should_panic(expected = "only the two signers")]
fn outsider_cannot_approve_admin_actions() {
    let (mut c, _) = setup();
    ctx("mallory.testnet", 0, 0);
    c.approve_action(Action::AddMechanic { account: acct("mallory.testnet") });
}

#[test]
fn one_signer_alone_changes_nothing() {
    let (mut c, _) = setup();
    ctx("a.testnet", 0, 0);
    let act = Action::AddMechanic { account: acct("x.testnet") };
    assert!(!c.approve_action(act.clone()));
    assert!(!c.approve_action(act));
    assert!(!c.is_mechanic(acct("x.testnet")));
}

#[test]
fn earmark_is_spent_before_the_shared_pool() {
    let (mut c, t) = setup();
    ctx("donor.testnet", 600, 0);
    c.fund(Some(0));
    let (id, _) = to_voting(&mut c, &t, 0, 10 * SEC);
    assert_eq!(c.get_pump(0).unwrap().earmark.0, 0);
    assert_eq!(c.get_config().free.0, 99_600);
    assert_eq!(c.get_job(id).unwrap().from_earmark_left.0, 600);
}

#[test]
fn too_few_replies_allow_a_redraw_then_dispute() {
    let (mut c, t) = setup();
    let (id, _) = to_voting(&mut c, &t, 0, 10 * SEC);
    ctx("anyone.testnet", 0, 70 * SEC);
    c.redraw_sample(id);
    assert_eq!(c.get_job(id).unwrap().redraws, 1);
    ctx("anyone.testnet", 0, 130 * SEC);
    c.redraw_sample(id);
    ctx("anyone.testnet", 0, 200 * SEC);
    c.redraw_sample(id);
    assert_eq!(c.get_job(id).unwrap().status, Status::Disputed);
}

#[test]
fn deactivated_household_is_never_asked() {
    let (mut c, t) = setup();
    for s in ["a.testnet", "b.testnet"] {
        ctx(s, 0, 0);
        c.approve_action(Action::DeactivateHousehold { hh: 5 });
    }
    let (_, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    assert!(!asked.contains(&5));
}

#[test]
#[should_panic(expected = "household inactive")]
fn deactivated_household_cannot_report() {
    let (mut c, t) = setup();
    for s in ["a.testnet", "b.testnet"] {
        ctx(s, 0, 0);
        c.approve_action(Action::DeactivateHousehold { hh: 5 });
    }
    ctx("relay.testnet", 0, 0);
    c.report_broken(0, t.cred(5, 0, ACT_REPORT));
}

#[test]
fn nft_views_exist_and_tokens_do_not_move() {
    let (c, _) = setup();
    assert_eq!(c.nft_total_supply().0, 2 + HH as u128);
    assert!(c.nft_token("pump-1".into()).is_some());
    assert_eq!(c.nft_token("hh-3".into()).unwrap().owner_id, "hh-3.pool.testnet");
    assert!(c.nft_token("hh-99".into()).is_none());
}

#[test]
#[should_panic(expected = "non-transferable")]
fn nft_transfer_always_fails() {
    let (mut c, _) = setup();
    ctx("a.testnet", 1, 0);
    c.nft_transfer(acct("x.testnet"), "pump-0".into());
}

/// Golden vector produced by web/public/merkle.js (leafHash(3, 2, 1, "ABCD")). If this fails, the
/// browser/relayer and the contract disagree on how a code is hashed.
#[test]
fn leaf_hash_matches_the_javascript_implementation() {
    ctx("a.testnet", 0, 0);
    let mut d = b"bh1".to_vec();
    d.extend_from_slice(&3u32.to_le_bytes());
    d.push(2);
    d.push(1);
    d.extend_from_slice(b"ABCD");
    let h = env::sha256_array(&d);
    let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "f762184b282337d09cf8eed8e089aeb632b1757f103f7d9cb6bf257095c0d77d");
}
