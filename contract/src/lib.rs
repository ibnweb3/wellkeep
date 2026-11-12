//! Borehole pool: a keyless community repair fund for water points.
//!
//! Money in: anyone calls `fund`. Money out: only through the repair rule
//! (report -> accept -> post_fix -> sample vote -> 70% paid -> 30% released after a hold).
//! Households authenticate with one-time codes from a printed card, checked against a
//! Merkle root fixed at enrolment. A relayer submits the calls, so households hold no NEAR.
//! Admin actions (add mechanic, add pump, ...) need BOTH signer accounts to approve the same action.

use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

const ACT_REPORT: u8 = 0;
const ACT_YES: u8 = 1;
const ACT_NO: u8 = 2;

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Params {
    /// How long the final share is held after approval (ns).
    pub hold_ns: U64,
    /// How long votes may be collected before the sample can be redrawn (ns).
    pub vote_window_ns: U64,
    /// Minimum number of replies before a verdict (capped by how many were asked).
    pub min_replies: u32,
    /// Households drawn at random per repair, in addition to the reporters.
    pub sample_size: u32,
    /// Highest price a mechanic may quote for one job (yoctoNEAR).
    pub max_price: U128,
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
    pub from_earmark_left: U128,
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
}

#[near(serializers=[borsh, json])]
#[derive(Clone)]
pub struct Pump {
    pub name: String,
    pub open_job: Option<u64>,
    pub held_job: Option<u64>,
    pub earmark: U128,
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
    AddPump { name: String },
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
    free: U128,
    pumps: LookupMap<u32, Pump>,
    jobs: LookupMap<u64, Job>,
    ledger: LookupMap<u64, Entry>,
    mechanics: LookupSet<AccountId>,
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
            mechanics: LookupSet::new(b"m".to_vec()),
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

    fn pump_mut(&mut self, id: u32) -> Pump {
        self.pumps.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown pump"))
    }

    fn job_get(&self, id: u64) -> Job {
        self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("unknown job"))
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

    fn reserve(&mut self, pump: u32, price: u128) -> u128 {
        let mut p = self.pump_mut(pump);
        let from_e = p.earmark.0.min(price);
        let from_f = price - from_e;
        require!(self.free.0 >= from_f, "fund cannot cover this price");
        p.earmark = U128(p.earmark.0 - from_e);
        self.free = U128(self.free.0 - from_f);
        self.pumps.insert(pump, p);
        from_e
    }

    fn refund(&mut self, job: &mut Job, amount: u128) {
        if amount == 0 {
            return;
        }
        let e = job.from_earmark_left.0.min(amount);
        job.from_earmark_left = U128(job.from_earmark_left.0 - e);
        let mut p = self.pump_mut(job.pump);
        p.earmark = U128(p.earmark.0 + e);
        self.pumps.insert(job.pump, p);
        self.free = U128(self.free.0 + (amount - e));
    }

    fn consume(job: &mut Job, amount: u128) {
        let e = job.from_earmark_left.0.min(amount);
        job.from_earmark_left = U128(job.from_earmark_left.0 - e);
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
            Self::consume(&mut job, first);
            job.paid = U128(first);
            job.held = U128(held);
            job.approved_ns = U64(env::block_timestamp());
            let mut p = self.pump_mut(job.pump);
            p.open_job = None;
            if held > 0 {
                job.status = Status::Approved;
                p.held_job = Some(job_id);
            } else {
                job.status = Status::Completed;
            }
            self.pumps.insert(job.pump, p);
            self.log("pay_first", Some(job_id), Some(job.pump), first, mech.as_str());
            self.jobs.insert(job_id, job);
            Promise::new(mech).transfer(NearToken::from_yoctonear(first)).detach();
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
                self.mechanics.insert(account);
            }
            Action::RemoveMechanic { account } => {
                self.mechanics.remove(&account);
            }
            Action::AddPump { name } => {
                require!(!name.is_empty() && name.len() <= 64, "bad pump name");
                self.pumps.insert(
                    self.pump_count,
                    Pump { name, open_job: None, held_job: None, earmark: U128(0) },
                );
                self.pump_count += 1;
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
                        || j.status == Status::Accepted,
                    "job cannot be cancelled in this state"
                );
                let reserved = if j.status == Status::Reported { 0 } else { j.price.0 };
                self.refund(&mut j, reserved);
                j.status = Status::Cancelled;
                let mut p = self.pump_mut(j.pump);
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

    /// Anyone may add to the fund. `pump = None` goes to the shared pool.
    #[payable]
    pub fn fund(&mut self, pump: Option<u32>) {
        let amt = env::attached_deposit().as_yoctonear();
        require!(amt > 0, "attach a deposit");
        match pump {
            Some(id) => {
                let mut p = self.pump_mut(id);
                p.earmark = U128(p.earmark.0 + amt);
                self.pumps.insert(id, p);
            }
            None => self.free = U128(self.free.0 + amt),
        }
        let who = env::predecessor_account_id();
        self.log("fund", None, pump, amt, who.as_str());
    }

    // ---- reporting and repair --------------------------------------------------------------

    pub fn report_broken(&mut self, pump: u32, cred: Credential) -> u64 {
        let hh = self.check_credential(&cred, ACT_REPORT);
        let mut p = self.pump_mut(pump);
        // A report during the hold window counts towards forfeiting the held share.
        if let Some(hj) = p.held_job {
            let mut held = self.job_get(hj);
            let window_end = held.approved_ns.0 + self.params.hold_ns.0;
            if env::block_timestamp() < window_end && !held.rebroken.contains(&hh) {
                held.rebroken.push(hh);
                if held.rebroken.len() as u32 >= self.params.rebroken_needed {
                    let amount = held.held.0;
                    self.refund(&mut held, amount);
                    held.held = U128(0);
                    held.status = Status::Forfeited;
                    // refund() wrote the pump's earmark, so reload before clearing the hold.
                    p = self.pump_mut(pump);
                    p.held_job = None;
                    self.pumps.insert(pump, p.clone());
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
            from_earmark_left: U128(0),
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
        };
        p.open_job = Some(id);
        self.pumps.insert(pump, p);
        self.jobs.insert(id, job);
        self.log("report", Some(id), Some(pump), 0, &format!("hh-{hh}"));
        id
    }

    /// A registered mechanic takes the job at a quoted price; the amount is reserved from the fund.
    pub fn accept_job(&mut self, job: u64, price: U128) {
        let who = env::predecessor_account_id();
        require!(self.mechanics.contains(&who), "not a registered mechanic");
        let mut j = self.job_get(job);
        require!(j.status == Status::Reported, "job is not open for acceptance");
        require!(price.0 > 0 && price.0 <= self.params.max_price.0, "price outside the allowed range");
        let from_e = self.reserve(j.pump, price.0);
        j.from_earmark_left = U128(from_e);
        j.price = price;
        j.mechanic = Some(who.clone());
        j.status = Status::Accepted;
        self.log("accept", Some(job), Some(j.pump), price.0, who.as_str());
        self.jobs.insert(job, j);
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
        Self::consume(&mut j, amount);
        j.paid = U128(j.paid.0 + amount);
        j.held = U128(0);
        j.status = Status::Completed;
        let mut p = self.pump_mut(j.pump);
        if p.held_job == Some(job) {
            p.held_job = None;
        }
        self.pumps.insert(j.pump, p);
        self.log("pay_held", Some(job), Some(j.pump), amount, mech.as_str());
        self.jobs.insert(job, j);
        Promise::new(mech).transfer(NearToken::from_yoctonear(amount)).detach();
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
        self.mechanics.contains(&account)
    }

    pub fn is_slot_used(&self, hh: u32, slot: u8) -> bool {
        self.used.contains(&(((hh as u64) << 8) | slot as u64))
    }

    // ---- NFT views (NEP-171 reads). Tokens are records, not tradable assets -----------------

    pub fn nft_total_supply(&self) -> U128 {
        U128((self.pump_count as u128) + (self.total_households as u128))
    }

    pub fn nft_token(&self, token_id: String) -> Option<serde_json_view::NftToken> {
        let me = env::current_account_id();
        if let Some(n) = token_id.strip_prefix("pump-").and_then(|s| s.parse::<u32>().ok()) {
            let p = self.pumps.get(&n)?;
            return Some(serde_json_view::NftToken {
                token_id,
                owner_id: me.to_string(),
                title: p.name.clone(),
                description: "Water point record: service history is the list of jobs for this pump.".into(),
            });
        }
        if let Some(n) = token_id.strip_prefix("hh-").and_then(|s| s.parse::<u32>().ok()) {
            if n >= self.total_households {
                return None;
            }
            return Some(serde_json_view::NftToken {
                token_id: token_id.clone(),
                owner_id: format!("hh-{n}.{me}"),
                title: format!("Household pass {n}"),
                description: "Identity for voting. Non-transferable; the roll is kept by the two signers.".into(),
            });
        }
        None
    }

    /// Present so wallets see the NEP-171 shape; tokens cannot move.
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String) {
        let _ = (receiver_id, token_id);
        env::panic_str("tokens are non-transferable records");
    }
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
    }

    #[near(serializers=[json])]
    pub struct NftToken {
        pub token_id: String,
        pub owner_id: String,
        pub title: String,
        pub description: String,
    }
}

#[cfg(test)]
mod tests;
