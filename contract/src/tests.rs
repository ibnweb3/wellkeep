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

const TOKEN: &str = "usdc.testnet";
const STEWARD: &str = "council.testnet";

fn params() -> Params {
    Params {
        token: acct(TOKEN),
        hold_ns: U64(100 * SEC),
        vote_window_ns: U64(50 * SEC),
        min_replies: 3,
        sample_size: 4,
        max_price: U128(10_000),
        tier0_cap: U128(1_500),
        tier1_cap: U128(4_000),
        first_pct: 70,
        rebroken_needed: 2,
        max_attempts: 2,
    }
}

/// A donor's stablecoin arriving through ft_transfer_call.
fn deposit(c: &mut Contract, from: &str, amount: u128, msg: &str) -> u128 {
    ctx(TOKEN, 0, 0);
    match c.ft_on_transfer(acct(from), U128(amount), msg.to_string()) {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
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
        Action::AddPump { name: "Well 1".into(), steward: acct(STEWARD) },
        Action::AddPump { name: "Well 2".into(), steward: acct(STEWARD) },
    ] {
        ctx("a.testnet", 0, 0);
        assert!(!c.approve_action(act.clone()));
        ctx("b.testnet", 0, 0);
        assert!(c.approve_action(act));
    }
    assert_eq!(deposit(&mut c, "donor.testnet", 100_000, "pool"), 0);
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
    assert_eq!(deposit(&mut c, "donor.testnet", 500, "pump:1"), 0);
    let cfg = c.get_config();
    assert_eq!(cfg.free.0, 100_000);
    assert_eq!(c.get_pump(1).unwrap().earmark.0, 500);
    // two pump_added + the shared deposit + this one
    assert_eq!(c.list_ledger(0, 10).len(), 4);
}

#[test]
fn unknown_pump_or_message_is_refunded() {
    let (mut c, _) = setup();
    assert_eq!(deposit(&mut c, "donor.testnet", 500, "pump:9"), 500);
    assert_eq!(deposit(&mut c, "donor.testnet", 500, "hello"), 500);
    assert_eq!(c.get_config().free.0, 100_000);
}

#[test]
#[should_panic(expected = "only the pool's stablecoin")]
fn only_the_stablecoin_can_call_ft_on_transfer() {
    let (mut c, _) = setup();
    ctx("donor.testnet", 0, 0);
    let _ = c.ft_on_transfer(acct("donor.testnet"), U128(5), "pool".into());
}

#[test]
fn a_pump_is_an_account_with_a_holder() {
    let (c, _) = setup();
    let p = c.get_pump(0).unwrap();
    assert_eq!(p.vault.to_string(), "pump-0.pool.testnet");
    assert_eq!(p.steward.to_string(), STEWARD);
    assert_eq!(p.holders.len(), 1);
    assert_eq!(c.get_pump(1).unwrap().vault.to_string(), "pump-1.pool.testnet");
    assert_eq!(c.get_config().vault_code_bytes as usize, VAULT_WASM.len());
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
    // the 300 went back to the pump's own balance (it never left the vault); a new job is open
    assert_eq!(c.get_pump(0).unwrap().earmark.0, 300);
    assert_eq!(c.get_pump(0).unwrap().forfeits, 1);
    assert_eq!(c.get_mechanic(acct("mech.testnet")).unwrap().forfeits, 1);
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
    assert_eq!(c.get_pump(0).unwrap().earmark.0, 1_000);
    assert_eq!(c.get_config().free.0, 99_000);
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
    for act in [
        Action::AddMechanic { account: acct("mech.testnet") },
        Action::AddPump { name: "W".into(), steward: acct(STEWARD) },
    ] {
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
    deposit(&mut c, "donor.testnet", 600, "pump:0");
    let (_, _) = to_voting(&mut c, &t, 0, 10 * SEC);
    // 600 came from the pump's own money, the other 400 from the shared fund
    assert_eq!(c.get_pump(0).unwrap().earmark.0, 0);
    assert_eq!(c.get_config().free.0, 99_600);
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
fn nft_views_exist() {
    let (c, _) = setup();
    assert_eq!(c.nft_total_supply().0, 2 + HH as u128);
    let t = c.nft_token("pump-1".into()).unwrap();
    assert_eq!(t.owner_id, STEWARD);
    assert!(t.transferable);
    assert_eq!(t.account_id.unwrap().to_string(), "pump-1.pool.testnet");
    let h = c.nft_token("hh-3".into()).unwrap();
    assert_eq!(h.owner_id, "hh-3.pool.testnet");
    assert!(!h.transferable);
    assert!(c.nft_token("hh-99".into()).is_none());
    assert_eq!(c.nft_supply_for_owner(acct(STEWARD)).0, 2);
    assert_eq!(c.nft_tokens_for_owner(acct(STEWARD), None, None).len(), 2);
}

fn hand_over(c: &mut Contract, from: &str, to: &str, token: &str, t: u64) {
    ctx(from, 1, t);
    c.nft_transfer(acct(to), token.into(), None, None);
}

#[test]
fn pump_nft_transfer_moves_the_stewardship() {
    let (mut c, _) = setup();
    hand_over(&mut c, STEWARD, "village.testnet", "pump-0", 5 * SEC);
    let p = c.get_pump(0).unwrap();
    assert_eq!(p.steward.to_string(), "village.testnet");
    assert_eq!(p.holders.len(), 2);
    assert_eq!(c.nft_token("pump-0".into()).unwrap().owner_id, "village.testnet");
    assert_eq!(c.nft_supply_for_owner(acct(STEWARD)).0, 1);
    // the other pump did not move
    assert_eq!(c.get_pump(1).unwrap().steward.to_string(), STEWARD);
}

#[test]
#[should_panic(expected = "only the current holder")]
fn only_the_holder_can_transfer() {
    let (mut c, _) = setup();
    hand_over(&mut c, "mallory.testnet", "mallory.testnet", "pump-0", 0);
}

#[test]
#[should_panic(expected = "1 yoctoNEAR")]
fn transfer_needs_one_yocto() {
    let (mut c, _) = setup();
    ctx(STEWARD, 0, 0);
    c.nft_transfer(acct("x.testnet"), "pump-0".into(), None, None);
}

#[test]
#[should_panic(expected = "non-transferable")]
fn household_passes_cannot_move() {
    let (mut c, _) = setup();
    hand_over(&mut c, STEWARD, "x.testnet", "hh-1", 0);
}

fn ask_for_big_quote(c: &mut Contract, t: &Tree, price: u128) -> u64 {
    ctx("relay.testnet", 0, 0);
    let id = c.report_broken(0, t.cred(0, 0, ACT_REPORT));
    ctx("mech.testnet", 0, 0);
    c.accept_job(id, U128(price));
    id
}

#[test]
fn a_quote_above_the_tier_waits_for_the_steward() {
    let (mut c, t) = setup();
    let id = ask_for_big_quote(&mut c, &t, 3_000); // tier0 is 1_500
    let j = c.get_job(id).unwrap();
    assert_eq!(j.status, Status::Quoted);
    assert_eq!(c.get_config().free.0, 100_000); // nothing reserved yet
    ctx(STEWARD, 0, 1);
    c.steward_approve(id);
    let j = c.get_job(id).unwrap();
    assert_eq!(j.status, Status::Accepted);
    assert_eq!(c.get_config().free.0, 97_000);
}

#[test]
#[should_panic(expected = "only this pump's steward")]
fn a_stranger_cannot_approve_a_quote() {
    let (mut c, t) = setup();
    let id = ask_for_big_quote(&mut c, &t, 3_000);
    ctx("mallory.testnet", 0, 1);
    c.steward_approve(id);
}

#[test]
fn the_steward_can_turn_a_quote_down() {
    let (mut c, t) = setup();
    let id = ask_for_big_quote(&mut c, &t, 3_000);
    ctx(STEWARD, 0, 1);
    c.steward_reject(id);
    let j = c.get_job(id).unwrap();
    assert_eq!(j.status, Status::Reported);
    assert!(j.mechanic.is_none());
    // a cheaper quote now goes straight through
    ctx("mech.testnet", 0, 2);
    c.accept_job(id, U128(1_000));
    assert_eq!(c.get_job(id).unwrap().status, Status::Accepted);
}

#[test]
fn the_mechanic_can_withdraw_a_waiting_quote() {
    let (mut c, t) = setup();
    let id = ask_for_big_quote(&mut c, &t, 3_000);
    ctx("mech.testnet", 0, 1);
    c.withdraw_quote(id);
    assert_eq!(c.get_job(id).unwrap().status, Status::Reported);
}

#[test]
fn transferring_the_nft_hands_quote_approval_to_the_new_holder() {
    let (mut c, t) = setup();
    let id = ask_for_big_quote(&mut c, &t, 3_000);
    hand_over(&mut c, STEWARD, "village.testnet", "pump-0", SEC);
    ctx("village.testnet", 0, 2 * SEC);
    c.steward_approve(id);
    assert_eq!(c.get_job(id).unwrap().status, Status::Accepted);
}

#[test]
#[should_panic(expected = "only this pump's steward")]
fn the_old_holder_loses_quote_approval_after_a_transfer() {
    let (mut c, t) = setup();
    let id = ask_for_big_quote(&mut c, &t, 3_000);
    hand_over(&mut c, STEWARD, "village.testnet", "pump-0", SEC);
    ctx(STEWARD, 0, 2 * SEC);
    c.steward_approve(id);
}

#[test]
fn a_sale_in_the_middle_of_a_payout_still_pays_the_mechanic() {
    let (mut c, t) = setup();
    let (id, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    // the NFT changes hands while the village is still voting
    hand_over(&mut c, STEWARD, "village.testnet", "pump-0", 12 * SEC);
    for hh in asked.iter().copied().take(3) {
        ctx("relay.testnet", 0, 20 * SEC);
        c.vote(id, true, t.cred(hh, if hh == 0 { 1 } else { 0 }, ACT_YES));
    }
    let j = c.get_job(id).unwrap();
    assert_eq!(j.status, Status::Approved);
    assert_eq!(j.mechanic.unwrap().to_string(), "mech.testnet"); // payee fixed when the job was taken
    assert_eq!(j.paid.0, 700);
    // the new holder owns the pump, its money and its history
    let p = c.get_pump(0).unwrap();
    assert_eq!(p.steward.to_string(), "village.testnet");
    assert_eq!(p.paid_total.0, 700);
    assert_eq!(p.holders.len(), 2);
}

#[test]
fn the_steward_sets_a_cap_for_their_pump() {
    let (mut c, t) = setup();
    ctx(STEWARD, 0, 0);
    c.set_quote_cap(0, U128(800));
    ctx("relay.testnet", 0, 0);
    let id = c.report_broken(0, t.cred(0, 0, ACT_REPORT));
    ctx("mech.testnet", 0, 0);
    c.accept_job(id, U128(800)); // allowed
    assert_eq!(c.get_job(id).unwrap().status, Status::Accepted);
}

#[test]
#[should_panic(expected = "price outside the allowed range")]
fn a_quote_above_the_pump_cap_is_refused() {
    let (mut c, t) = setup();
    ctx(STEWARD, 0, 0);
    c.set_quote_cap(0, U128(800));
    ctx("relay.testnet", 0, 0);
    let id = c.report_broken(0, t.cred(0, 0, ACT_REPORT));
    ctx("mech.testnet", 0, 0);
    c.accept_job(id, U128(801));
}

#[test]
#[should_panic(expected = "only this pump's steward")]
fn only_the_steward_sets_the_cap() {
    let (mut c, _) = setup();
    ctx("mallory.testnet", 0, 0);
    c.set_quote_cap(0, U128(1));
}

#[test]
fn finished_jobs_raise_a_mechanics_automatic_limit() {
    let (mut c, t) = setup();
    assert_eq!(c.get_mechanic(acct("mech.testnet")).unwrap().auto_cap.0, 1_500);
    let (id, asked) = to_voting(&mut c, &t, 0, 10 * SEC);
    for hh in asked.iter().copied().take(3) {
        ctx("relay.testnet", 0, 20 * SEC);
        c.vote(id, true, t.cred(hh, if hh == 0 { 1 } else { 0 }, ACT_YES));
    }
    // only the first 70% is paid; the job counts as finished once the held 30% is released too
    assert_eq!(c.get_mechanic(acct("mech.testnet")).unwrap().paid_jobs, 0);
    ctx("anyone.testnet", 0, 20 * SEC + 100 * SEC);
    c.release_held(id);
    let m = c.get_mechanic(acct("mech.testnet")).unwrap();
    assert_eq!((m.paid_jobs, m.score, m.earned.0), (1, 1, 1_000));
    assert_eq!(m.auto_cap.0, 4_000);
    assert_eq!(c.get_pump(0).unwrap().jobs_paid, 1);
    assert_eq!(c.list_mechanics().len(), 1);
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
