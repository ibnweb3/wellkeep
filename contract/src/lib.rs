//! WellKeep pool v2: a keyless community repair fund for water points, paid in a NEP-141 stablecoin.
//!
//! Each water point is an NFT (`pump-N`, NEP-171) AND an account: the pool creates a keyless vault
//! sub-account `pump-N.<pool>` that physically holds that pump's repair money. Whoever holds the NFT is the
//! pump's steward (it can be a person, a committee or a Sputnik DAO) and transfers with the token.
//!
//! Money in: a donor sends the stablecoin with `ft_transfer_call` (msg `pump:N` or `pool`).
//! Money out: only through the repair rule
//!   report -> quote -> approval by tier -> fix -> sample vote -> 70% paid -> 30% released after a hold.
//! Approval tiers: a quote within the mechanic's track-record limit is taken at once; a quote up to `mid_cap`
//! needs ONE deputy (a council member) or the steward; a quote above `mid_cap` needs the steward, which for a
//! pump held by a DAO is a proposal the whole council votes on.
//! Households authenticate with one-time codes from a printed card, checked against a Merkle root fixed
//! at enrolment. A relayer submits the calls, so households hold no NEAR.
//! Admin actions (add mechanic, add pump, ...) need BOTH signer accounts to approve the same action.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

/// Exact bytes of the vault contract. Every pump vault is created from these bytes, with no keys.
const VAULT_WASM: &[u8] = include_bytes!("../../evidence/wellkeep_vault.wasm");
/// NEAR the pool puts into each new vault for its storage.
const VAULT_DEPOSIT: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
/// What a NEP-141 contract charges to register one account.
const TOKEN_STORAGE: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR
const ONE_YOCTO: u128 = 1;
const MAX_DEPUTIES: usize = 5;

const ACT_REPORT: u8 = 0;
const ACT_YES: u8 = 1;
const ACT_NO: u8 = 2;

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Params {
    /// The NEP-141 stablecoin every amount is in (USDC on testnet).
    pub token: AccountId,
    /// How long the final share is held after approval (ns).
    pub hold_ns: U64,
    /// How long votes may be collected before the sample can be redrawn (ns).
    pub vote_window_ns: U64,
    /// Minimum number of replies before a verdict (capped by how many were asked).
    pub min_replies: u32,
    /// Households drawn at random per repair, in addition to the reporters.
    pub sample_size: u32,
    /// Highest price any quote may have (token base units).
    pub max_price: U128,
    /// Largest quote a mechanic with no finished jobs may take without the steward's approval.
    pub tier0_cap: U128,
    /// Same for a mechanic with a little track record (score 1 or 2).
    pub tier1_cap: U128,
    /// Largest quote one deputy (council member) may approve alone. Above it only the steward may approve.
    pub mid_cap: U128,
    /// Percent paid at approval; the rest is held.
    pub first_pct: u8,
    /// Distinct households that must report "broken again" during the hold to forfeit it.
    pub rebroken_needed: u32,
    /// Failed verdicts allowed before a job is marked disputed.
    pub max_attempts: u8,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Batch {
    pub root: Base64VecU8,
    pub start: u32,
    pub count: u32,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, PartialEq, Debug)]
pub enum Status {
    Reported,
    /// A quote above the mechanic's tier, waiting for the pump's steward.
    Quoted,
    Accepted,
    Voting,
    Approved,
    Completed,
    Forfeited,
    Disputed,
    Cancelled,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub pump: u32,
    pub status: Status,
    pub reporters: Vec<u32>,
    pub opened_ns: U64,
    pub mechanic: Option<AccountId>,
    pub price: U128,
    pub eligible: Vec<u32>,
    pub yes: Vec<u32>,
    pub no: Vec<u32>,
    pub draw_ns: U64,
    pub redraws: u8,
    pub attempts: u8,
    pub approved_ns: U64,
    pub paid: U128,
    pub held: U128,
    pub rebroken: Vec<u32>,
    /// True when a waiting quote is above `mid_cap`, so only the steward (not a deputy) may approve it.
    pub above_mid: bool,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Holder {
    pub account: AccountId,
    pub since_ns: U64,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Pump {
    pub name: String,
    pub open_job: Option<u64>,
    pub held_job: Option<u64>,
    /// Stablecoin in this pump's vault that is not reserved for a job (token base units).
    pub earmark: U128,
    /// The keyless account that holds this pump's money.
    pub vault: AccountId,
    /// Holder of the pump NFT: approves big quotes, sets the quote cap, can hand the pump on.
    pub steward: AccountId,
    /// Council members who may approve a quote up to `mid_cap` alone (set by the steward).
    pub deputies: Vec<AccountId>,
    /// Highest quote this pump accepts (set by the steward, at most the global max).
    pub quote_cap: U128,
    pub paid_total: U128,
    pub jobs_paid: u32,
    pub forfeits: u32,
    /// Everyone who has held the NFT, oldest first.
    pub holders: Vec<Holder>,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Rep {
    pub active: bool,
    pub paid_jobs: u32,
    pub earned: U128,
    pub forfeits: u32,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Entry {
    pub ts: U64,
    pub kind: String,
    pub job: Option<u64>,
    pub pump: Option<u32>,
    pub amount: U128,
    pub who: String,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Credential {
    pub batch: u32,
    pub hh: u32,
    pub slot: u8,
    pub code: String,
    pub proof: Vec<Base64VecU8>,
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub enum Action {
    AddMechanic { account: AccountId },
    RemoveMechanic { account: AccountId },
    AddPump { name: String, steward: AccountId, deputies: Vec<AccountId> },
    DeactivateHousehold { hh: u32 },
    AddBatch { root: Base64VecU8, count: u32 },
    CancelJob { job: u64 },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    signers: [AccountId; 2],
    params: Params,
    batches: Vec<Batch>,
    total_households: u32,
    pump_count: u32,
    job_count: u64,
    ledger_count: u64,
    /// Shared money held by the pool account itself (not yet assigned to a pump).
    free: U128,
    pumps: LookupMap<u32, Pump>,
    jobs: LookupMap<u64, Job>,
    ledger: LookupMap<u64, Entry>,
    mechanics: LookupMap<AccountId, Rep>,
    mech_list: Vec<AccountId>,
    used: LookupSet<u64>,
    inactive: LookupSet<u32>,
    pending: LookupMap<[u8; 32], u8>,
}

impl Contract {
    /// Builds the initial state without touching the environment, so the same bytes can be
    /// produced off-chain for a deterministic (keyless) account.
    pub fn build(
        signers: [AccountId; 2],
        params: Params,
        root: Vec<u8>,
        households: u32,
    ) -> Self {
        require!(root.len() == 32, "root must be 32 bytes");
        require!(households > 0, "need households");
        require!(signers[0] != signers[1], "signers must differ");
        require!(params.first_pct > 0 && params.first_pct <= 100, "bad first_pct");
        require!(
            params.tier0_cap.0 > 0
                && params.tier0_cap.0 <= params.tier1_cap.0
                && params.tier1_cap.0 <= params.mid_cap.0
                && params.mid_cap.0 <= params.max_price.0,
            "tier caps must satisfy 0 < tier0 <= tier1 <= mid_cap <= max_price"
        );
        Self {
            signers,
            params,
            batches: vec![Batch { root: Base64VecU8::from(root), start: 0, count: households }],
            total_households: households,
            pump_count: 0,
            job_count: 0,
            ledger_count: 0,
            free: U128(0),
            pumps: LookupMap::new(b"p".to_vec()),
            jobs: LookupMap::new(b"j".to_vec()),
            ledger: LookupMap::new(b"l".to_vec()),
            mechanics: LookupMap::new(b"m".to_vec()),
            mech_list: vec![],
            used: LookupSet::new(b"u".to_vec()),
            inactive: LookupSet::new(b"i".to_vec()),
            pending: LookupMap::new(b"a".to_vec()),
        }
    }

    fn log(&mut self, kind: &str, job: Option<u64>, pump: Option<u32>, amount: u128, who: &str) {
        let e = Entry {
            ts: U64(env::block_timestamp()),
            kind: kind.to_string(),
            job,
            pump,
            amount: U128(amount),
            who: who.to_string(),
        };
        self.ledger.insert(self.ledger_count, e);
        self.ledger_count += 1;
    }

    fn pump_get(&self, id: u32) -> Pump {
        self.pumps.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown pump"))
    }

    fn job_get(&self, id: u64) -> Job {
        self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown job"))
    }

    fn rep_get(&self, who: &AccountId) -> Option<Rep> {
        self.mechanics.get(who).cloned()
    }

    /// Trust score: finished jobs, minus two per forfeited one.
    fn score(r: &Rep) -> u32 {
        r.paid_jobs.saturating_sub(r.forfeits.saturating_mul(2))
    }

    /// The largest quote this mechanic may take without the steward saying yes.
    fn tier_cap(&self, r: &Rep) -> u128 {
        match Self::score(r) {
            0 => self.params.tier0_cap.0,
            1 | 2 => self.params.tier1_cap.0,
            _ => self.params.max_price.0,
        }
    }

    fn token_call(&self, method: &str, args: serde_json::Value, deposit: u128, tgas: u64) -> Promise {
        Promise::new(self.params.token.clone()).function_call(
            method.to_string(),
            args.to_string().into_bytes(),
            NearToken::from_yoctonear(deposit),
            Gas::from_tgas(tgas),
        )
    }

    /// Pool sends stablecoin it holds (the shared fund) to a vault.
    fn send_token(&self, to: &AccountId, amount: u128) {
        self.token_call(
            "ft_transfer",
            json!({ "receiver_id": to, "amount": amount.to_string() }),
            ONE_YOCTO,
            20,
        )
        .detach();
    }

    /// A vault pays out (only the pool can make it), then the pool hears whether the token moved.
    fn pay_out(&self, pump: u32, to: &AccountId, amount: u128, job: u64, kind: &str) {
        let vault = self.pump_get(pump).vault;
        let pay = Promise::new(vault).function_call(
            "pay".to_string(),
            json!({ "to": to, "amount": amount.to_string() }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(40),
        );
        let after = Promise::new(env::current_account_id()).function_call(
            "on_paid".to_string(),
            json!({ "job": job, "pump": pump, "amount": amount.to_string(), "to": to, "kind": kind })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(0),
            Gas::from_tgas(10),
        );
        pay.then(after).detach();
    }

    fn event(event: &str, data: serde_json::Value) {
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({ "standard": "nep171", "version": "1.2.0", "event": event, "data": [data] })
        ));
    }

    /// Verifies a one-time code against the Merkle root and burns the slot.
    fn check_credential(&mut self, c: &Credential, action: u8) -> u32 {
        let b = self
            .batches
            .get(c.batch as usize)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown batch"));
        require!(c.hh >= b.start && c.hh < b.start + b.count, "household not in batch");
        require!(!self.inactive.contains(&c.hh), "household inactive");
        let key = ((c.hh as u64) << 8) | c.slot as u64;
        require!(!self.used.contains(&key), "code slot already used");
        let mut data = b"bh1".to_vec();
        data.extend_from_slice(&c.hh.to_le_bytes());
        data.push(c.slot);
        data.push(action);
        data.extend_from_slice(c.code.as_bytes());
        let mut h = env::sha256_array(&data);
        for p in &c.proof {
            require!(p.0.len() == 32, "bad proof element");
            let (lo, hi): (&[u8], &[u8]) =
                if h.as_slice() <= p.0.as_slice() { (&h, &p.0) } else { (&p.0, &h) };
            let mut buf = [0u8; 64];
            buf[..32].copy_from_slice(lo);
            buf[32..].copy_from_slice(hi);
            h = env::sha256_array(&buf);
        }
        require!(h.as_slice() == b.root.0.as_slice(), "invalid code");
        self.used.insert(key);
        c.hh
    }

    fn draw_sample(&self, job: &mut Job) {
        let n = self.total_households;
        let seed = env::random_seed();
        let mut want = self.params.sample_size as usize;
        let mut counter: u32 = 0;
        let mut tries = 0u32;
        while want > 0 && tries < n.saturating_mul(8).max(64) {
            let mut d = seed.clone();
            d.extend_from_slice(&job.id.to_le_bytes());
            d.extend_from_slice(&job.redraws.to_le_bytes());
            d.extend_from_slice(&counter.to_le_bytes());
            let h = env::sha256_array(&d);
            let pick = u32::from_le_bytes([h[0], h[1], h[2], h[3]]) % n;
            counter += 1;
            tries += 1;
            if self.inactive.contains(&pick) || job.eligible.contains(&pick) {
                continue;
            }
            job.eligible.push(pick);
            want -= 1;
        }
    }

    /// Sets `price` aside for a job. The pump's own money is used first; any shortfall comes from the
    /// shared fund and is sent to the pump's vault, so the vault always holds what is reserved.
    fn reserve(&mut self, pump: u32, price: u128) {
        let mut p = self.pump_get(pump);
        let need = price.saturating_sub(p.earmark.0);
        require!(self.free.0 >= need, "fund cannot cover this price");
        self.free = U128(self.free.0 - need);
        p.earmark = U128(p.earmark.0 + need - price);
        let vault = p.vault.clone();
        self.pumps.insert(pump, p);
        if need > 0 {
            self.send_token(&vault, need);
        }
    }

    /// Money that was reserved goes back to the pump's own balance (it never left the vault).
    fn refund(&mut self, pump: u32, amount: u128) {
        if amount == 0 {
            return;
        }
        let mut p = self.pump_get(pump);
        p.earmark = U128(p.earmark.0 + amount);
        self.pumps.insert(pump, p);
    }

    fn take_job(&mut self, mut j: Job, who: AccountId, price: u128) {
        self.reserve(j.pump, price);
        j.price = U128(price);
        j.mechanic = Some(who.clone());
        j.status = Status::Accepted;
        self.log("accept", Some(j.id), Some(j.pump), price, who.as_str());
        self.jobs.insert(j.id, j);
    }

    fn record_payment(&mut self, pump: u32, mech: &AccountId, amount: u128, finished: bool) {
        let mut p = self.pump_get(pump);
        p.paid_total = U128(p.paid_total.0 + amount);
        if finished {
            p.jobs_paid += 1;
        }
        self.pumps.insert(pump, p);
        if let Some(mut r) = self.rep_get(mech) {
            r.earned = U128(r.earned.0 + amount);
            if finished {
                r.paid_jobs += 1;
            }
            self.mechanics.insert(mech.clone(), r);
        }
    }

    fn evaluate(&mut self, job_id: u64) {
        let mut job = self.job_get(job_id);
        if job.status != Status::Voting {
            return;
        }
        let replies = (job.yes.len() + job.no.len()) as u32;
        let needed = self.params.min_replies.min(job.eligible.len() as u32);
        if replies < needed || replies == 0 {
            return;
        }
        let yes = job.yes.len() as u32;
        if yes * 3 >= replies * 2 {
            let price = job.price.0;
            let first = price * self.params.first_pct as u128 / 100;
            let held = price - first;
            let mech = job.mechanic.clone().unwrap();
            job.paid = U128(first);
            job.held = U128(held);
            job.approved_ns = U64(env::block_timestamp());
            let mut p = self.pump_get(job.pump);
            p.open_job = None;
            if held > 0 {
                job.status = Status::Approved;
                p.held_job = Some(job_id);
            } else {
                job.status = Status::Completed;
            }
            self.pumps.insert(job.pump, p);
            self.log("pay_first", Some(job_id), Some(job.pump), first, mech.as_str());
            let pump = job.pump;
            let done = held == 0;
            self.jobs.insert(job_id, job);
            self.record_payment(pump, &mech, first, done);
            self.pay_out(pump, &mech, first, job_id, "first");
        } else {
            job.attempts += 1;
            job.yes.clear();
            job.no.clear();
            job.eligible.clear();
            if job.attempts >= self.params.max_attempts {
                job.status = Status::Disputed;
                self.log("disputed", Some(job_id), Some(job.pump), 0, "");
            } else {
                job.status = Status::Accepted;
                self.log("rejected", Some(job_id), Some(job.pump), 0, "");
            }
            self.jobs.insert(job_id, job);
        }
    }

    fn execute(&mut self, action: Action) {
        match action {
            Action::AddMechanic { account } => {
                match self.rep_get(&account) {
                    Some(mut r) => {
                        r.active = true;
                        self.mechanics.insert(account.clone(), r);
                    }
                    None => {
                        self.mechanics.insert(
                            account.clone(),
                            Rep { active: true, paid_jobs: 0, earned: U128(0), forfeits: 0 },
                        );
                        self.mech_list.push(account.clone());
                    }
                }
                // Make sure the stablecoin contract can pay this mechanic.
                self.token_call(
                    "storage_deposit",
                    json!({ "account_id": account, "registration_only": true }),
                    TOKEN_STORAGE,
                    10,
                )
                .detach();
            }
            Action::RemoveMechanic { account } => {
                if let Some(mut r) = self.rep_get(&account) {
                    r.active = false;
                    self.mechanics.insert(account, r);
                }
            }
            Action::AddPump { name, steward, deputies } => {
                require!(!name.is_empty() && name.len() <= 64, "bad pump name");
                require!(deputies.len() <= MAX_DEPUTIES, "too many deputies");
                let id = self.pump_count;
                let me = env::current_account_id();
                let vault: AccountId = format!("pump-{id}.{me}")
                    .parse()
                    .unwrap_or_else(|_| env::panic_str("bad vault account name"));
                // A keyless account whose code is the embedded vault: created with NO access key.
                Promise::new(vault.clone())
                    .create_account()
                    .transfer(NearToken::from_yoctonear(VAULT_DEPOSIT))
                    .deploy_contract(VAULT_WASM.to_vec())
                    .function_call(
                        "new".to_string(),
                        json!({ "pool": me, "token": self.params.token }).to_string().into_bytes(),
                        NearToken::from_yoctonear(0),
                        Gas::from_tgas(10),
                    )
                    .detach();
                // The vault must be registered with the stablecoin to receive it.
                self.token_call(
                    "storage_deposit",
                    json!({ "account_id": vault, "registration_only": true }),
                    TOKEN_STORAGE,
                    10,
                )
                .detach();
                let now = env::block_timestamp();
                self.pumps.insert(
                    id,
                    Pump {
                        name,
                        open_job: None,
                        held_job: None,
                        earmark: U128(0),
                        vault,
                        steward: steward.clone(),
                        deputies,
                        quote_cap: self.params.max_price,
                        paid_total: U128(0),
                        jobs_paid: 0,
                        forfeits: 0,
                        holders: vec![Holder { account: steward.clone(), since_ns: U64(now) }],
                    },
                );
                self.pump_count += 1;
                self.log("pump_added", None, Some(id), 0, steward.as_str());
                Self::event(
                    "nft_mint",
                    json!({ "owner_id": steward, "token_ids": [format!("pump-{id}")] }),
                );
            }
            Action::DeactivateHousehold { hh } => {
                require!(hh < self.total_households, "unknown household");
                self.inactive.insert(hh);
            }
            Action::AddBatch { root, count } => {
                require!(root.0.len() == 32 && count > 0, "bad batch");
                self.batches.push(Batch { root, start: self.total_households, count });
                self.total_households += count;
            }
            Action::CancelJob { job } => {
                let mut j = self.job_get(job);
                require!(
                    j.status == Status::Disputed
                        || j.status == Status::Reported
                        || j.status == Status::Quoted
                        || j.status == Status::Accepted,
                    "job cannot be cancelled in this state"
                );
                let reserved = match j.status {
                    Status::Reported | Status::Quoted => 0,
                    _ => j.price.0,
                };
                self.refund(j.pump, reserved);
                j.status = Status::Cancelled;
                let mut p = self.pump_get(j.pump);
                if p.open_job == Some(job) {
                    p.open_job = None;
                }
                self.pumps.insert(j.pump, p);
                self.log("cancelled", Some(job), Some(j.pump), reserved, "");
                self.jobs.insert(job, j);
            }
        }
    }
}

#[near]
impl Contract {
    #[init]
    pub fn new(signers: [AccountId; 2], params: Params, root: Base64VecU8, households: u32) -> Self {
        Self::build(signers, params, root.0, households)
    }

    // ---- money in -------------------------------------------------------------------------

    /// NEP-141 receiver. A donor calls `ft_transfer_call` on the stablecoin with msg `pump:N`
    /// (that water point's own money) or `pool` (the shared fund). Anything else is refunded.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.params.token, "only the pool's stablecoin can be sent here");
        if amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        let msg = msg.trim();
        if msg.is_empty() || msg == "pool" {
            self.free = U128(self.free.0 + amount.0);
            self.log("fund", None, None, amount.0, sender_id.as_str());
            return PromiseOrValue::Value(U128(0));
        }
        let id = msg.strip_prefix("pump:").and_then(|s| s.parse::<u32>().ok());
        let Some(id) = id else {
            return PromiseOrValue::Value(amount);
        };
        let Some(mut p) = self.pumps.get(&id).cloned() else {
            return PromiseOrValue::Value(amount);
        };
        p.earmark = U128(p.earmark.0 + amount.0);
        let vault = p.vault.clone();
        self.pumps.insert(id, p);
        self.log("fund", None, Some(id), amount.0, sender_id.as_str());
        // the tokens now sit in the pool's balance; move them straight into the pump's own vault
        self.send_token(&vault, amount.0);
        PromiseOrValue::Value(U128(0))
    }

    /// Callback after a vault tried to pay: if the stablecoin refused, the ledger says so.
    #[private]
    pub fn on_paid(&mut self, job: u64, pump: u32, amount: U128, to: AccountId, kind: String) {
        if env::promise_result_checked(0, 1024).is_err() {
            self.log(&format!("pay_failed_{kind}"), Some(job), Some(pump), amount.0, to.as_str());
        }
    }

    // ---- reporting and repair --------------------------------------------------------------

    pub fn report_broken(&mut self, pump: u32, cred: Credential) -> u64 {
        let hh = self.check_credential(&cred, ACT_REPORT);
        let mut p = self.pump_get(pump);
        // A report during the hold window counts towards forfeiting the held share.
        if let Some(hj) = p.held_job {
            let mut held = self.job_get(hj);
            let window_end = held.approved_ns.0 + self.params.hold_ns.0;
            if env::block_timestamp() < window_end && !held.rebroken.contains(&hh) {
                held.rebroken.push(hh);
                if held.rebroken.len() as u32 >= self.params.rebroken_needed {
                    let amount = held.held.0;
                    self.refund(pump, amount);
                    held.held = U128(0);
                    held.status = Status::Forfeited;
                    // refund() wrote the pump's earmark, so reload before clearing the hold.
                    p = self.pump_get(pump);
                    p.held_job = None;
                    p.forfeits += 1;
                    self.pumps.insert(pump, p.clone());
                    if let Some(m) = held.mechanic.clone() {
                        if let Some(mut r) = self.rep_get(&m) {
                            r.forfeits += 1;
                            self.mechanics.insert(m, r);
                        }
                    }
                    self.log("forfeit", Some(hj), Some(pump), amount, "");
                }
                self.jobs.insert(hj, held);
            }
        }
        if let Some(oj) = p.open_job {
            let mut job = self.job_get(oj);
            if !job.reporters.contains(&hh) {
                job.reporters.push(hh);
                self.jobs.insert(oj, job);
            }
            self.log("report", Some(oj), Some(pump), 0, &format!("hh-{hh}"));
            return oj;
        }
        let id = self.job_count;
        self.job_count += 1;
        let job = Job {
            id,
            pump,
            status: Status::Reported,
            reporters: vec![hh],
            opened_ns: U64(env::block_timestamp()),
            mechanic: None,
            price: U128(0),
            eligible: vec![],
            yes: vec![],
            no: vec![],
            draw_ns: U64(0),
            redraws: 0,
            attempts: 0,
            approved_ns: U64(0),
            paid: U128(0),
            held: U128(0),
            rebroken: vec![],
            above_mid: false,
        };
        p.open_job = Some(id);
        self.pumps.insert(pump, p);
        self.jobs.insert(id, job);
        self.log("report", Some(id), Some(pump), 0, &format!("hh-{hh}"));
        id
    }

    /// A registered mechanic quotes a price. Within their tier the job is taken at once and the money
    /// is reserved; above it, the quote waits for the pump's steward (`steward_approve`).
    pub fn accept_job(&mut self, job: u64, price: U128) {
        let who = env::predecessor_account_id();
        let rep = self.rep_get(&who).filter(|r| r.active);
        let Some(rep) = rep else { env::panic_str("not a registered mechanic") };
        let j = self.job_get(job);
        require!(j.status == Status::Reported, "job is not open for acceptance");
        let p = self.pump_get(j.pump);
        require!(
            price.0 > 0 && price.0 <= self.params.max_price.0 && price.0 <= p.quote_cap.0,
            "price outside the allowed range"
        );
        if price.0 <= self.tier_cap(&rep) {
            self.take_job(j, who, price.0);
        } else {
            let mut j = j;
            j.mechanic = Some(who.clone());
            j.price = price;
            j.above_mid = price.0 > self.params.mid_cap.0;
            j.status = Status::Quoted;
            self.log("quote", Some(job), Some(j.pump), price.0, who.as_str());
            self.jobs.insert(job, j);
        }
    }

    /// Who may decide on a waiting quote: the steward always; a deputy only if the quote is up to `mid_cap`.
    fn may_decide(&self, p: &Pump, j: &Job, who: &AccountId) -> bool {
        *who == p.steward || (!j.above_mid && p.deputies.contains(who))
    }

    /// Approves a quote that was above the mechanic's tier. The steward (NFT holder) may always; a deputy
    /// (council member) may when the quote is up to `mid_cap`.
    pub fn steward_approve(&mut self, job: u64) {
        let j = self.job_get(job);
        require!(j.status == Status::Quoted, "no quote is waiting on this job");
        let p = self.pump_get(j.pump);
        let who = env::predecessor_account_id();
        require!(
            self.may_decide(&p, &j, &who),
            "this quote needs the pump's steward (above the deputy limit) or a deputy (up to it)"
        );
        let mech = j.mechanic.clone().unwrap();
        let price = j.price.0;
        self.log("steward_ok", Some(job), Some(j.pump), price, who.as_str());
        self.take_job(j, mech, price);
    }

    /// Turns a waiting quote down; the job goes back to open. Same authority as approving it.
    pub fn steward_reject(&mut self, job: u64) {
        let mut j = self.job_get(job);
        require!(j.status == Status::Quoted, "no quote is waiting on this job");
        let p = self.pump_get(j.pump);
        require!(
            self.may_decide(&p, &j, &env::predecessor_account_id()),
            "this quote needs the pump's steward (above the deputy limit) or a deputy (up to it)"
        );
        j.status = Status::Reported;
        j.mechanic = None;
        j.price = U128(0);
        self.log("quote_rejected", Some(job), Some(j.pump), 0, env::predecessor_account_id().as_str());
        self.jobs.insert(job, j);
    }

    /// The mechanic takes their own waiting quote back.
    pub fn withdraw_quote(&mut self, job: u64) {
        let mut j = self.job_get(job);
        require!(j.status == Status::Quoted, "no quote is waiting on this job");
        require!(j.mechanic.as_ref() == Some(&env::predecessor_account_id()), "not your quote");
        j.status = Status::Reported;
        j.mechanic = None;
        j.price = U128(0);
        self.log("quote_withdrawn", Some(job), Some(j.pump), 0, "");
        self.jobs.insert(job, j);
    }

    /// The steward sets the highest quote this pump will take (never above the global maximum).
    pub fn set_quote_cap(&mut self, pump: u32, cap: U128) {
        let mut p = self.pump_get(pump);
        require!(env::predecessor_account_id() == p.steward, "only this pump's steward can set its cap");
        require!(cap.0 > 0 && cap.0 <= self.params.max_price.0, "cap must be between 0 and the global maximum");
        p.quote_cap = cap;
        let who = p.steward.clone();
        self.pumps.insert(pump, p);
        self.log("set_cap", None, Some(pump), cap.0, who.as_str());
    }

    /// The steward adds or removes a deputy (a council member who may approve mid-size quotes alone).
    pub fn set_deputy(&mut self, pump: u32, account: AccountId, on: bool) {
        let mut p = self.pump_get(pump);
        require!(env::predecessor_account_id() == p.steward, "only this pump's steward can change its deputies");
        p.deputies.retain(|d| *d != account);
        if on {
            require!(p.deputies.len() < MAX_DEPUTIES, "too many deputies");
            p.deputies.push(account.clone());
        }
        let who = p.steward.clone();
        self.pumps.insert(pump, p);
        self.log(if on { "deputy_added" } else { "deputy_removed" }, None, Some(pump), 0, &format!("{who} -> {account}"));
    }

    /// The mechanic says the repair is done. This draws the random sample of households.
    pub fn post_fix(&mut self, job: u64) {
        let who = env::predecessor_account_id();
        let mut j = self.job_get(job);
        require!(j.status == Status::Accepted, "job is not awaiting a fix");
        require!(j.mechanic.as_ref() == Some(&who), "only the job's mechanic can post the fix");
        j.eligible = j.reporters.clone();
        self.draw_sample(&mut j);
        j.draw_ns = U64(env::block_timestamp());
        j.status = Status::Voting;
        self.log("fix_posted", Some(job), Some(j.pump), 0, who.as_str());
        self.jobs.insert(job, j);
    }

    /// Households asked (reporters plus the random sample) answer "works" or "does not work".
    pub fn vote(&mut self, job: u64, works: bool, cred: Credential) {
        let action = if works { ACT_YES } else { ACT_NO };
        let mut j = self.job_get(job);
        require!(j.status == Status::Voting, "job is not being voted on");
        let hh = self.check_credential(&cred, action);
        require!(j.eligible.contains(&hh), "this household was not asked about this job");
        require!(!j.yes.contains(&hh) && !j.no.contains(&hh), "already voted");
        if works {
            j.yes.push(hh);
        } else {
            j.no.push(hh);
        }
        self.log("vote", Some(job), Some(j.pump), 0, &format!("hh-{hh}"));
        self.jobs.insert(job, j);
        self.evaluate(job);
    }

    /// If too few replied in time, anyone may draw more households (at most twice); after that
    /// the job is marked disputed and needs both signers.
    pub fn redraw_sample(&mut self, job: u64) {
        let mut j = self.job_get(job);
        require!(j.status == Status::Voting, "job is not being voted on");
        require!(
            env::block_timestamp() > j.draw_ns.0 + self.params.vote_window_ns.0,
            "vote window still open"
        );
        let replies = (j.yes.len() + j.no.len()) as u32;
        let needed = self.params.min_replies.min(j.eligible.len() as u32);
        require!(replies < needed, "enough replies already");
        if j.redraws >= 2 {
            j.status = Status::Disputed;
            self.log("disputed", Some(job), Some(j.pump), 0, "");
        } else {
            j.redraws += 1;
            self.draw_sample(&mut j);
            j.draw_ns = U64(env::block_timestamp());
            self.log("redraw", Some(job), Some(j.pump), 0, "");
        }
        self.jobs.insert(job, j);
    }

    /// Anyone may release the held share once the hold has passed with no forfeit.
    pub fn release_held(&mut self, job: u64) {
        let mut j = self.job_get(job);
        require!(j.status == Status::Approved, "nothing held for this job");
        require!(
            env::block_timestamp() >= j.approved_ns.0 + self.params.hold_ns.0,
            "hold period not over"
        );
        let amount = j.held.0;
        let mech = j.mechanic.clone().unwrap();
        j.paid = U128(j.paid.0 + amount);
        j.held = U128(0);
        j.status = Status::Completed;
        let pump = j.pump;
        let mut p = self.pump_get(pump);
        if p.held_job == Some(job) {
            p.held_job = None;
        }
        self.pumps.insert(pump, p);
        self.log("pay_held", Some(job), Some(pump), amount, mech.as_str());
        self.jobs.insert(job, j);
        self.record_payment(pump, &mech, amount, true);
        self.pay_out(pump, &mech, amount, job, "held");
    }

    // ---- admin: both signers must approve the same action ----------------------------------

    pub fn approve_action(&mut self, action: Action) -> bool {
        let who = env::predecessor_account_id();
        let idx = self
            .signers
            .iter()
            .position(|s| *s == who)
            .unwrap_or_else(|| env::panic_str("only the two signers can approve actions"));
        let bytes = near_sdk::borsh::to_vec(&action).unwrap();
        let key = env::sha256_array(&bytes);
        let mask = self.pending.get(&key).copied().unwrap_or(0) | (1 << idx);
        if mask == 3 {
            self.pending.remove(&key);
            self.execute(action);
            true
        } else {
            self.pending.insert(key, mask);
            false
        }
    }

    // ---- views -------------------------------------------------------------------------------

    pub fn get_config(&self) -> serde_json_view::Config {
        serde_json_view::Config {
            signers: self.signers.to_vec(),
            params: self.params.clone(),
            batches: self.batches.clone(),
            total_households: self.total_households,
            pump_count: self.pump_count,
            job_count: U64(self.job_count),
            ledger_count: U64(self.ledger_count),
            free: self.free,
            vault_code_hash: hex(&env::sha256_array(VAULT_WASM)),
            vault_code_bytes: VAULT_WASM.len() as u32,
        }
    }

    pub fn get_pump(&self, id: u32) -> Option<Pump> {
        self.pumps.get(&id).cloned()
    }

    pub fn list_pumps(&self) -> Vec<(u32, Pump)> {
        (0..self.pump_count).filter_map(|i| self.pumps.get(&i).map(|p| (i, p.clone()))).collect()
    }

    pub fn get_job(&self, id: u64) -> Option<Job> {
        self.jobs.get(&id).cloned()
    }

    pub fn list_jobs(&self, from: u64, limit: u64) -> Vec<Job> {
        (from..self.job_count.min(from + limit)).filter_map(|i| self.jobs.get(&i).cloned()).collect()
    }

    pub fn list_ledger(&self, from: u64, limit: u64) -> Vec<Entry> {
        (from..self.ledger_count.min(from + limit))
            .filter_map(|i| self.ledger.get(&i).cloned())
            .collect()
    }

    pub fn is_mechanic(&self, account: AccountId) -> bool {
        self.rep_get(&account).map(|r| r.active).unwrap_or(false)
    }

    /// A mechanic's public record and the largest quote they may take without steward approval.
    pub fn get_mechanic(&self, account: AccountId) -> Option<serde_json_view::MechanicView> {
        let r = self.rep_get(&account)?;
        Some(self.mech_view(account, r))
    }

    pub fn list_mechanics(&self) -> Vec<serde_json_view::MechanicView> {
        self.mech_list
            .iter()
            .filter_map(|a| self.rep_get(a).map(|r| self.mech_view(a.clone(), r)))
            .collect()
    }

    fn mech_view(&self, account: AccountId, r: Rep) -> serde_json_view::MechanicView {
        serde_json_view::MechanicView {
            account,
            active: r.active,
            paid_jobs: r.paid_jobs,
            earned: r.earned,
            forfeits: r.forfeits,
            score: Self::score(&r),
            auto_cap: U128(self.tier_cap(&r)),
        }
    }

    pub fn is_slot_used(&self, hh: u32, slot: u8) -> bool {
        self.used.contains(&(((hh as u64) << 8) | slot as u64))
    }

    // ---- NEP-171. Pump tokens are real: they move, and the holder is the steward. -------------
    // Household passes are credentials for voting and cannot move.

    pub fn nft_metadata(&self) -> serde_json_view::NftContractMetadata {
        serde_json_view::NftContractMetadata {
            spec: "nft-1.0.0".into(),
            name: "WellKeep water points and household passes".into(),
            symbol: "WELL".into(),
        }
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128((self.pump_count as u128) + (self.total_households as u128))
    }

    pub fn nft_token(&self, token_id: String) -> Option<serde_json_view::NftToken> {
        let me = env::current_account_id();
        if let Some(n) = token_id.strip_prefix("pump-").and_then(|s| s.parse::<u32>().ok()) {
            let p = self.pumps.get(&n)?;
            return Some(self.pump_token(n, p));
        }
        if let Some(n) = token_id.strip_prefix("hh-").and_then(|s| s.parse::<u32>().ok()) {
            if n >= self.total_households {
                return None;
            }
            let title = format!("Household pass {n}");
            let description =
                "Credential to vote on repairs. Non-transferable; the roll is kept by the two signers.".to_string();
            return Some(serde_json_view::NftToken {
                token_id: token_id.clone(),
                owner_id: format!("hh-{n}.{me}"),
                metadata: serde_json_view::TokenMetadata { title: title.clone(), description: description.clone() },
                title,
                description,
                account_id: None,
                transferable: false,
            });
        }
        None
    }

    fn pump_token(&self, n: u32, p: &Pump) -> serde_json_view::NftToken {
        let title = p.name.clone();
        let description = "Water point. Its holder is its steward; its repair money sits in its own keyless vault account.".to_string();
        serde_json_view::NftToken {
            token_id: format!("pump-{n}"),
            owner_id: p.steward.to_string(),
            metadata: serde_json_view::TokenMetadata { title: title.clone(), description: description.clone() },
            title,
            description,
            account_id: Some(p.vault.clone()),
            transferable: true,
        }
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128((0..self.pump_count).filter(|i| self.pumps.get(i).map(|p| p.steward == account_id).unwrap_or(false)).count() as u128)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<serde_json_view::NftToken> {
        let from = from_index.map(|x| x.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50) as usize;
        (0..self.pump_count)
            .filter_map(|i| self.pumps.get(&i).filter(|p| p.steward == account_id).map(|p| self.pump_token(i, p)))
            .skip(from)
            .take(limit)
            .collect()
    }

    /// NEP-171 transfer for a water-point token. The new holder becomes the steward at once; the
    /// money stays in the pump's vault and any payout already in motion still goes to its mechanic.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let _ = (approval_id, memo);
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "attach exactly 1 yoctoNEAR"
        );
        let Some(n) = token_id.strip_prefix("pump-").and_then(|s| s.parse::<u32>().ok()) else {
            env::panic_str("household passes are non-transferable credentials");
        };
        let mut p = self.pump_get(n);
        let sender = env::predecessor_account_id();
        require!(sender == p.steward, "only the current holder can transfer this token");
        require!(receiver_id != sender, "receiver is already the holder");
        p.steward = receiver_id.clone();
        p.holders.push(Holder { account: receiver_id.clone(), since_ns: U64(env::block_timestamp()) });
        self.pumps.insert(n, p);
        self.log("nft_transfer", None, Some(n), 0, receiver_id.as_str());
        Self::event(
            "nft_transfer",
            json!({ "old_owner_id": sender, "new_owner_id": receiver_id, "token_ids": [token_id] }),
        );
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub mod serde_json_view {
    use super::*;

    #[near(serializers=[json])]
    pub struct Config {
        pub signers: Vec<AccountId>,
        pub params: Params,
        pub batches: Vec<Batch>,
        pub total_households: u32,
        pub pump_count: u32,
        pub job_count: U64,
        pub ledger_count: U64,
        pub free: U128,
        pub vault_code_hash: String,
        pub vault_code_bytes: u32,
    }

    #[near(serializers=[json])]
    pub struct TokenMetadata {
        pub title: String,
        pub description: String,
    }

    #[near(serializers=[json])]
    pub struct NftToken {
        pub token_id: String,
        pub owner_id: String,
        pub metadata: TokenMetadata,
        /// Same as metadata.title and metadata.description, kept for simple readers.
        pub title: String,
        pub description: String,
        /// The keyless account that holds this token's money (water points only).
        pub account_id: Option<AccountId>,
        pub transferable: bool,
    }

    #[near(serializers=[json])]
    pub struct NftContractMetadata {
        pub spec: String,
        pub name: String,
        pub symbol: String,
    }

    #[near(serializers=[json])]
    pub struct MechanicView {
        pub account: AccountId,
        pub active: bool,
        pub paid_jobs: u32,
        pub earned: U128,
        pub forfeits: u32,
        pub score: u32,
        pub auto_cap: U128,
    }
}

#[cfg(test)]
mod tests;
