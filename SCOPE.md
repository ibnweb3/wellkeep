# SCOPE: WellKeep (community water-point repair fund on NEAR)

Status: first approved by the owner 2026-11-12. Rebuilt as "v2" on 2026-11-14 after the owner asked for a strong fit to three tracks instead of two weak ones. This file describes what is built now; the first version's choices that v2 replaced are listed at the end. Development ends 2026-11-14 23:59 UTC.
Tracks: NFTs That Do Something, Real-World Money, Social Money.

## One-line idea

A donor pays for a borehole; this is the public repair fund that keeps it working. Every water point is an NFT and its own keyless account holding its repair money in USDC. A village committee (a Sputnik DAO) holds the NFTs. A mechanic is paid only when villagers confirm the fix, and every payment is public.

## Who it is for

The donor (or diaspora giver) who funded a pump and does not want it to fail for lack of maintenance. The villagers use a printed card and an SMS or shared phone. The mechanic is the only person who handles money. The committee decides on big quotes.

## How it works (as built)

1. A donor sends USDC (`ft_transfer_call`) to one pump's account or to the shared pool.
2. The pool and every pump account have no access keys. Money leaves a pump's account only when the pool tells its vault to pay, and the pool does that only through the repair rule.
3. Any household can report "pump broken" using a one-time code from its card. That opens a job.
4. A registered mechanic quotes a price. A quote within the mechanic's track-record limit reserves the money at once. A mid-size quote (up to 3 USDC) is approved by one deputy, a council member of that pump, or the steward. A large quote (up to 4 USDC) waits for the pump's steward, the holder of the pump's NFT. For the Village A pumps the steward is the village committee DAO, so that approval is a DAO proposal.
5. The mechanic posts the fix. The reporting households, plus eight random households, say whether the pump works. At least five replies and two thirds yes are needed.
6. On approval 70% is paid from the pump's own account. The other 30% is held (one hour on this testnet build) and released unless two different households report the pump broken again.
7. Everything is public: balances (read from the USDC contract), jobs, votes, payments, invoices, mechanic records, DAO proposals.

## Why this design (what the field research changed)

Source: the research report the owner commissioned (not independently re-checked; I rely only on the peer-reviewed parts and mark the rest weak).

- Scheduled visits lose to on-demand repair (Rwanda trial; delays over 24 h doubled diarrhea in Kwale) -> a report opens the job, no fixed schedule.
- Single-pump funds fail (pumps can break up to 11 times a year; FundiFix pools) -> a shared pool plus a separate account per pump that is topped up from the pool when a job needs more than the pump holds.
- Majority-of-all-households voting is unreachable (about 20% of rural areas lack signal, rural literacy 54% in Nigeria, households move) -> reporters plus a random sample, with a minimum number of replies.
- A mechanic bond punishes honest mechanics (worn parts, dry sources) -> no bond; the held 30% is the incentive, and track record raises how much a mechanic may quote without approval.
- Gatherings and shared phones remove secrecy -> private one-time scratch codes.
- Fingerprints: dropped (measured failure rates and data-protection law).

## Built (IN)

1. **Pool contract (Rust, near-sdk)**, a global contract referenced BY HASH, on a keyless deterministic `0s` account. Reports, quotes, steward approval, one-time-code voting, random sample, two-stage payment, forfeit rule, two-signer admin.
2. **Vault contract (no SDK, 3.9 KB)**, embedded in the pool. The pool creates one keyless sub-account `pump-N.<pool>` per water point from it. It can pay only when its parent pool calls it.
3. **NEP-171 NFTs.** `pump-N` transfers and carries stewardship (approve big quotes, set the pump's quote cap); `hh-N` household passes are credentials and do not transfer. Holder history and per-pump totals are on-chain.
4. **NEP-141 money.** Circle's testnet USDC. Donations by `ft_transfer_call`; payouts by the vault's `ft_transfer`; the pool registers mechanics and vaults at the token.
5. **Reputation and three approval tiers.** A mechanic's score (finished jobs minus two per forfeited share) sets an automatic quote limit: 1, 2 or 4 USDC. Above it, a quote up to 3 USDC needs one deputy (council member) or the steward; a quote up to 4 USDC needs the steward (a DAO vote for Village A).
6. **Village committee.** A Sputnik DAO (`wellkeep-village.sputnikv2.testnet`, 3 council accounts, 2 of 3) holds the Village A pump NFTs; its three council accounts are the pumps' deputies. Village B pumps are held by the sandbox account so a visitor can play the steward.
7. **"Check before you give" verifier.** Recomputes the pool's address from its code and starting state, and checks by RPC: zero keys, code by hash, code identical to the repository wasm, rules match, and every pump account has zero keys and runs the exact vault code.
8. **Gasless villagers.** A relayer pays the gas for reports and votes; the one-time code is the credential, checked on-chain.
9. **Web app (Cloudflare Worker static assets).** Water points, pump pages with steward desk, invoices and CSV, public ledger, community (mechanic records and DAO proposals), a sandbox to play every role, the verifier.
10. **Tests, README, evidence.** 47 contract tests, JS tests, a live run of the three tiers on real USDC, a scratch run with a mock token. Invoice payment lines link to their transactions through the explorer's token-transfer index.

## OUT (not built, and said so)

- Real mobile money, cash, or any fiat on-ramp or off-ramp.
- The SMS gateway. The SMS path is described, not wired.
- NEAR Intents top-ups. Intents has no testnet.
- A meta-transaction relay for mechanics and stewards (they sign with their own wallet).
- Crediting a plain USDC transfer sent straight to a pump's account (it is held safely but uncounted until `ft_transfer_call`).
- Sensors, biometrics, photo or GPS proof, mainnet deployment, real stablecoins, any real personal data.
- A real wallet-signed donation, quote or NFT transfer was not completed in my own test session. The relayer, sandbox, DAO and command-line paths were.

## NEAR centrality: the plain answer

What NEAR makes better or easier here:
- **The address proves the rules.** A deterministic account's address is derived from its code and starting data, with no keys. A donor can recompute it and check by RPC that nobody holds a key and the code cannot change.
- **The token is the account.** A water point's NFT and the keyless account that holds its money are one thing: a sub-account the contract creates with no key. Transferring the NFT moves control, not the money.
- **A committee that is an ordinary DAO.** The NFT can be held by a Sputnik DAO, so approvals need no new multisig.

What would work on any chain: the repair rule itself (reports, quotes, sample vote, two-stage payment). An EVM version with a factory, per-pump contracts and a paymaster could do much of it. We do not claim that only NEAR can do this.

## Honest limits

- A vote is the community saying the pump works, not proof that it does.
- Roll enrolment is a one-time trust point (two independent signers reduce it). On this testnet build both signers, and the DAO's three council accounts, are accounts the builder controls.
- On the Village B pumps the sandbox account is both steward and sandbox mechanic; the contract does not forbid that, and a real committee should not do it.
- Cards can be bought or stolen; keep payouts smaller than the cost of buying a quorum.
- Votes are linkable to a card number by anyone who knows which card belongs to whom.
- Where there is almost no phone coverage, this does not work.
- Prior art already works: FundiFix (pooled fund, M-Pesa, sensors, 3-day repairs). The difference offered: a donor-visible, keyless, pooled fund where nobody holds the money.
- Donor demand for maintenance (vs new wells) is unproven.
- Not tested with any village. This is a prototype that needs a field pilot.

## What v2 replaced from the first version

- Pumps were records inside one pool (a ledger line), not accounts; the NFTs were read-only and non-transferable. Now each pump is a real keyless account and its NFT transfers.
- The money was testnet NEAR; now it is USDC, with invoices and a CSV.
- Mechanics were an allow-list; now they have a public record and a trust-based quote limit, and larger quotes need the steward or a DAO vote.
- The first version's pool (`0s4123b90f113c99ea1492d8ef8e658f0890153193`) and wasm (`evidence/borehole_pool.wasm`) are kept as history only. A second pool without the deputy tier (`0sedce5ef2a8c3f587df86bd10a8a631fb9f7eaa19`) is superseded; its files are in `evidence/v2/`.

## Owner actions (not done by me)

- Record/post the X demo (the owner posts it), and submit the form with a mainnet NEAR payout account and the three tracks.
- Tell me when to record the demo video.
