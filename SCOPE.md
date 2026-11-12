# SCOPE: Borehole (community water-point repair fund on NEAR)

Status: approved by the owner 2026-11-12; amended 2026-11-13 with what actually got built (see "Changes made while building"). Development ends 2026-11-14 23:59 UTC.
Tracks: NFTs + Real-World Money.

## One-line idea

A donor pays for a borehole; this is the public repair fund that keeps it working. Nobody holds the money. A mechanic is paid only when villagers confirm the fix, and every payment is public.

## Who it is for

The donor (or diaspora giver) who funded a pump and does not want it to fail for lack of maintenance. The villagers use a printed card and an SMS or shared phone. The mechanic is the only person who handles money.

## How it works

1. A donor sends money into the community's pooled repair fund (the whole pool, or earmarked for one named pump).
2. The fund account has no access keys. Money leaves only through the repair rule.
3. Any household can report "pump broken" using a one-time code from its card. That opens a job.
4. A registered mechanic accepts the job and posts that it is fixed.
5. The reporting households, plus about 10 households picked at random, say whether the pump now works. A minimum number of replies and a two-thirds yes are needed.
6. On approval 70% is paid. The other 30% is held for 14 days and released unless a household reports the pump broken again.
7. Everything is public: balance, jobs, votes, payments.

## Why this design (what the field research changed)

Source: the research report the owner commissioned (not independently re-checked; I rely only on the peer-reviewed parts and mark the rest weak).

- Scheduled visits lose to on-demand repair (Rwanda trial; delays over 24 h doubled diarrhea in Kwale) -> a report opens the job, no fixed schedule.
- Single-pump funds fail (pumps can break up to 11 times a year; FundiFix pools) -> one pooled fund, with optional earmarks per pump.
- Majority-of-all-households voting is unreachable (about 20% of rural areas lack signal, rural literacy 54% in Nigeria, households move) -> reporters plus a random sample, with a minimum number of replies.
- A mechanic bond punishes honest mechanics (worn parts, dry sources) -> no bond; the 30% hold is the incentive.
- Gatherings and shared phones remove secrecy -> private one-time scratch codes; gathering only as a labelled fallback.
- Fingerprints: dropped. Reason: measured failure rates (Kenya 4.8%, Nigeria at least 10%) and Nigeria's data-protection law treating fingerprints as sensitive data. (I earlier said manual work wears fingerprints; the research found no statistical basis for that, so I do not claim it.)

## IN (what gets built)

1. **Pool contract (Rust, NEAR testnet)**, published as a global contract and referenced BY HASH. Functions: fund (with optional pump earmark), report_broken, accept_job, post_fix, vote, finalize, release_held, report_rebroken, roll/mechanic changes (2-of-2 by two signer accounts), and a household/pump NFT view (NEP-171 reads).
2. **Keyless fund by code hash.** The pool account is created with no access keys.
3. **"Check before you give" verifier.** One click in the UI recomputes the deterministic `0s` address from the code hash and initial storage, then confirms by RPC: zero access keys, code referenced by hash (not by publisher), roll hash matches. Results are recorded in `evidence/`.
4. **One-time scratch codes.** Per-household, per-answer codes verified against a Merkle root committed at enrolment. (Cut line: if this slips, fall back to relayer-submitted votes from household sub-account keys, stated in the README.)
5. **Random sample.** At review time the contract draws about 10 households using the on-chain random seed. Limit stated: block producers have slight influence over the seed; acceptable at these stakes.
6. **Gasless voting.** A relayer account submits the transaction and pays the gas, so households never hold NEAR. The one-time code is the credential, checked on-chain; the relayer has no special rights. (NEP-366 meta-transactions are NOT used: they would need a signing key per household, which the printed-code design avoids.)
7. **Two-stage payment** with a hold period (shortened to minutes in the demo build, clearly labelled).
8. **Named pump accounts: CUT.** Pumps are records inside the pool (token ids `pump-0`, `pump-1`, ...) with an earmark ledger; donors fund a pump by number. Nested sub-account names such as `well-3.<pool>` were not built (each would need its own forwarding contract and another publish).
9. **NFT views.** Household pass and pump record exposed as non-transferable NEP-171 tokens (transfer is disabled). Honest purpose: identity and service history, not a tradable asset.
10. **Web UI (Cloudflare Worker static assets):** community list and pump page, fund balance, report/vote screens (simulated card), job timeline, the verifier, and a public ledger.
11. **Tests, README, evidence folder.**
12. **Measured costs:** real testnet cost of creating the pool account, a pump account, and publishing the code (recorded, not copied from docs).

## Changes made while building

- Nested pump accounts cut; NEP-366 not used (see IN 6 and 8).
- The mechanic cash-out is not simulated in the UI at all; the UI and README say it is not built.
- The live pool holds a separate 3 NEAR storage reserve (not part of the tracked fund) so storage growth cannot starve payouts.
- Both signer accounts, the mechanic, the donor and the relayer are throwaway testnet accounts controlled by the builder. In a real deployment the signers would be two independent organisations.
- The web page reads the chain directly through a public RPC; only the relayer, the demo mechanic and the demo donor go through the Worker.

## OUT (not built, and said so)

- Real mobile money, cash, or any fiat on-ramp or off-ramp. The mechanic cash-out is a labelled SIMULATION.
- The SMS gateway. The SMS path is described, not wired (the gateway phone is shared with other projects).
- NEAR Intents top-ups. Intents has no testnet. Shown as a labelled simulation; at most one mainnet dry quote if the owner approves, never real funds.
- Sensors or accelerometers. A sensor is the stronger verifier (FundiFix uses them); this vote is the cheap fallback where sensors are not affordable. The design leaves a verifier slot, not built.
- Biometrics, photo/GPS proof, mainnet deployment, real stablecoins, any real personal data.

## 5-step demo flow (what a judge can do)

1. **Check before you give.** Open the pool page, press Verify. See the recomputed `0s` address match, zero access keys, code by hash.
2. **Fund.** A donor sends testnet NEAR to the pool, earmarked for a pump. Balance and public ledger update.
3. **Report.** A household enters a card code: "pump broken". A job opens.
4. **Fix and vote.** The mechanic posts the fix. The reporter and the randomly drawn sample vote with their codes. At threshold, 70% is paid to the mechanic's account.
5. **Hold and release.** After the (shortened) hold period the final 30% is released. Alternative path: a "broken again" report freezes it.

## NEAR centrality: the plain answer

What NEAR makes better or easier here:
- **The address proves the rules.** A deterministic account's address is derived from its code and starting data, with no keys. A donor can recompute it and check by RPC that nobody holds a key and the code cannot change (referenced by hash). This is the best claim we have.
- **Gasless users.** NEP-366 meta-transactions let villagers act without ever holding NEAR.
- **Cheap accounts at scale.** One global contract can serve any village; docs say using it costs under 0.001 NEAR. We will measure and record the real number.
- **Readable nested names**: NOT delivered (cut, see IN 8). Not claimed.
- **NEP-366 gasless transactions**: NOT used; a plain relayer pays gas.
- **Intents** would let diaspora donors pay from any chain, but this cannot be tested on testnet.

What would work on any chain: the repair rule itself (reports, jobs, sample vote, two-stage payment). An EVM version with a factory contract, a paymaster and an immutable proxy could do most of it, with less readable names and no address-from-code check. We will not claim that only NEAR can do this. Centrality is moderate; this is the honest assessment.

## NFT and Real-World Money fit

- **NFTs:** household pass (identity for voting) and pump record (service history). These are non-transferable records. The mechanic (keyless account holding money) is the organizers' own prompt, but it is also the most common NFT idea in the field (about 19 of 43 NFT entries), so this is not novel as a mechanism; the novelty is the domain.
- **Real-World Money:** donors' money pays a real-world worker for real-world work. In this build the money is testnet NEAR and the cash-out is simulated, so it demonstrates the flow, not a live payment rail. Nigeria and Kenya tightened stablecoin rules in November 2026, and no evidence was found of rural mechanics using stablecoins; a real deployment needs a licensed off-ramp partner.

## Honest limits (will be in the README)

- A vote is the community saying the pump works, not proof that it does.
- Roll enrolment is a one-time trust point (two independent signers reduce it).
- Cards can be bought or stolen; keep payouts smaller than the cost of buying a quorum.
- Votes are linkable to a card number by anyone who knows which card belongs to whom; threats cannot be prevented by the chain.
- A shared phone or gateway can drop votes (censor) but cannot forge or flip them.
- Where there is almost no phone coverage, this does not work.
- Prior art already works: FundiFix (pooled fund, M-Pesa, sensors, 3-day repairs). Blockchain water-maintenance pilots were not found; one 2020 IBM/SweetSense blockchain pilot is cited without status. The difference offered: a donor-visible, keyless, pooled fund where nobody holds the money.
- Donor demand for maintenance (vs new wells) is unproven.
- Not tested with any village. This is a prototype that needs a field pilot.

## Risks and cut lines (2 days)

| Risk | Plan |
| --- | --- |
| No Rust toolchain on this PC | Build in WSL Ubuntu (present). Fallback: Docker. |
| Global-contract publishing burns testnet NEAR (about 10 per 100 KB) | Keep wasm small; check faucet amounts early. Fallback: deploy to the pool account directly and delete its keys, and say honestly that this is "keys removed", not "by hash". |
| Deterministic-account creation tooling unfamiliar | Test with the docs' FT example first. |
| Merkle codes take too long | Cut to relayer-signed votes (see IN 4). |
| Named pump accounts take too long | Cut (see IN 8). |

Order of work: (1) toolchain + a deterministic account test, (2) contract + tests, (3) testnet deploy + evidence, (4) UI, (5) README, (6) de-vibe review pass after a checkpoint commit.

## Owner actions (not done by me)

- Approve the public repo creation and the push (account `ibnweb3`).
- Decide whether the README names the sibling entry (this links two identities).
- Record/post the X demo (they post it), and submit the form with a mainnet NEAR payout account.
- Tell me when to record the demo video.
