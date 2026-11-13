# WellKeep

A keyless repair fund for community water points, on NEAR testnet. Fund the repairs that keep a well giving water after the donor has gone.

**In 30 seconds.** A donor pays for a borehole, then it breaks because nobody has money to fix it. WellKeep is the repair fund that keeps it working, and nobody holds the money. A pump is reported broken with a one-time code from a printed household card. A registered mechanic takes the job. The reporter plus about eight randomly chosen households are asked "does it work now?". If two thirds say yes, the mechanic is paid 70% at once and the other 30% a short time later, unless two different households report the pump broken again. Every report, vote and payment is public. A donor can run one check that proves, from the chain alone, that no key exists for the fund and that its code cannot change.

Built on NEAR for NEAR HACKATHON. Tracks: NFTs and Real-World Money. NEAR pieces used: a keyless deterministic account running a global contract by hash, NEP-171 NFT records for every water point and household, NEAR's on-chain random seed, near-sdk, near-kit and a NEAR wallet (full map in "NEAR integration map" below). A second entry from the same author, [Cautio](https://github.com/ibnweb3/cautio) (rental deposits in a keyless NEAR account, [live](https://cautio.ibnweb3lab.workers.dev)), uses the same idea of an account that nobody holds a key to. This is a prototype on testnet with test money. It has not been tested with any real community.

## Try it (about five minutes)

**Play every role (no wallet, 3 minutes).** Open the live site, press **Try it** and walk one repair through all the roles: a villager reports a pump broken, a sandbox mechanic accepts and posts the fix, the village votes, and the mechanic is paid 70%. Every button sends a real NEAR testnet transaction and shows its link. The sandbox mechanic is `bh-relay.testnet`, an account registered on the pool as a mechanic; the Worker's `/api/sandbox` signs only `accept_job` and `post_fix` as that account, with quotes capped at 0.3 NEAR. Real mechanics use their own wallet on the water point's page.

**Fastest check, no wallet needed (2 minutes).** Open the live site and:

1. Press **Run the checks** (section "Check before you give"). You should see seven PASS lines: the pool account exists, has 0 access keys, its code is referenced by hash, and the address recomputed in your browser equals the fund's address.
2. Open **Watch a repair** and pick "Fixed and paid", then "Not really fixed". You should see 70% paid at once and 30% held in the first case, and nothing paid in the second. This animation is an example, labelled "not chain data".
3. Open **Water points**, then "Village A - health post". You should see a real job with its transactions: a payment of 0.35 NEAR with 0.15 NEAR held (the held share can be released after the one-hour hold).
4. Open **Public ledger**. You should see every deposit, report, vote and payment with its transaction link.

The fund numbers at the top of the home page refresh from the chain every 15 seconds and flash when they change.

Live (testnet): https://wellkeep.ibnweb3lab.workers.dev . Or run it locally:

```bash
npm install
npx wrangler dev          # needs .dev.vars with RELAY_KEY (a testnet key), see "Run it yourself"
```

Every role acts as itself. Nothing is played for you by the page:

1. **Check before you give.** Press "Run the checks". Seven checks run in your browser against the public RPC.
2. **Give (donor).** Press "Connect wallet" and choose a NEAR testnet wallet. Open a water point, enter an amount and give. You sign the payment yourself. See the ledger line.
3. **Report (household).** Open a working pump, type a household number, a card row and the code from that household's card, then press "Report broken". The relayer pays the fee; the household holds no NEAR. Sample cards for the fictional village are in `docs/test-cards.json` (testnet only; each code works once).
4. **Fix (mechanic).** A mechanic signs in with their own wallet. The account must first be registered by both signers: `node tools/admin.mjs add-mechanic <account.testnet>`. The mechanic accepts the job and posts the fix.
5. **Check (village).** The asked households each type their number and a code from the "It works" or "Still broken" column. At least five replies and two thirds "works" pays the mechanic 70%.
6. **Hold and release.** The rest is held (one hour on this testnet build, so the release can be watched; it is a parameter fixed in the pool's starting state). Anyone can press "Release" afterwards, or two different households report "broken again" and the held share goes back to the fund.

## What is on-chain and what is not

On NEAR testnet, real:

- A **keyless pool account**: `0s4123b90f113c99ea1492d8ef8e658f0890153193`. It has no access keys. Its code is a global contract referenced **by hash** (`3ecEVdauLBD77PNzxB7VjpeaDhX5wNdpw1iT1HrHdqW7`, 230,074 bytes), so nobody can swap the code.
- The repair rule: reports, jobs, one-time-code voting, the random sample, the 70/30 payment and the forfeit rule. All in `contract/src/lib.rs`.
- Admin actions (register a mechanic, add a pump, cancel a disputed job) need both signer accounts to approve the same action.
- A public ledger, and non-transferable NFT-style records (`pump-N`, `hh-N`) readable through `nft_token`.

Not real, and labelled as such in the site:

- The money is **testnet NEAR**. Nothing here touches mainnet.
- **Mobile-money cash-out is not built.** No fiat on-ramp or off-ramp exists in NEAR's docs, and none is faked here.
- **NEAR Intents top-ups are not built.** Intents has no testnet, so cross-chain giving cannot be shown honestly. The site says so.
- **The SMS gateway is not built.** The design assumes a feature phone sends the code by SMS; this build uses the browser.
- The village is fictional: three pumps named "Village A - ..." and 30 households with generated cards. The sample cards are public (`docs/test-cards.json`) so a reviewer can try the flow; their root is what the chain checks.
- The hold period is one hour so a reviewer can see the release; a real deployment would use days or weeks. It is a parameter fixed in the pool's starting state, so a longer hold means a new pool address (same code hash).
- Only the gas-paying relayer is run by this site. Donors and mechanics sign with their own wallets.
- Wallet signing goes through `@hot-labs/near-connect`. I could not complete a real wallet signature in my own test session, so the donor and mechanic paths are written and wired but not proven end to end by me.

## How it works

```
donor ──fund──▶ pool (keyless 0s account, code by hash)
                 │  free money + an earmark per pump
household card ─(one-time code)─▶ report_broken ─▶ job opens
mechanic ──accept_job(price reserved)──▶ post_fix ─▶ contract draws a random sample
asked households ──vote(code)──▶ ≥5 replies and ≥2/3 "works" ─▶ 70% paid, 30% held
hold ends, no forfeit ─▶ release_held (anyone) ─▶ 30% paid
2 different households report again during the hold ─▶ 30% returns to the fund
```

- **Household cards.** Each household has a card with a row of codes per use: one for "report", one for "works", one for "still broken". Only a Merkle root of all code hashes is stored on-chain. A code works once. A relayer submits calls, so households need no wallet.
- **Random sample.** When the fix is posted the contract draws eight households using NEAR's on-chain random seed. The mechanic cannot know whom to bribe in advance. (Block producers have slight influence over the seed; acceptable at these stakes, and said so.)
- **Why two stages, no bond.** Field research found that a mechanic bond punishes honest mechanics (worn parts, dry sources). The held 30% is the incentive.
- **Why pooled and on demand.** Evidence found that pumps break many times a year (FundiFix pools across pumps) and that on-demand repair beats scheduled visits (Rwanda trial), so there is one pooled fund with optional earmarks and a report opens the job.

## NEAR integration map

Every NEAR piece in this build, and where to find it:

| NEAR feature | What it does here | Where |
| --- | --- | --- |
| NEAR testnet | Holds the fund, jobs, votes and the public ledger | `wrangler.toml` (`POOL_ID`), `evidence/publish.json` |
| Global contract, referenced by hash | The pool's code lives once on-chain under hash `3ecEVdauLBD77PNzxB7VjpeaDhX5wNdpw1iT1HrHdqW7`; the pool points at the hash, so nobody can swap the code | `tools/publish.mjs`, `web/src/verify-core.js` (checks 3 to 5) |
| Deterministic `0s` account | The pool address is derived from its code and starting state and has no access keys | `tools/publish.mjs create`, `web/src/verify-core.js` (checks 2 and 6) |
| NEP-171 NFT records | `pump-N` and `hh-N` tokens, read with `nft_token` and `nft_total_supply`; `nft_transfer` is disabled on purpose (non-transferable records) | `contract/src/lib.rs` (NFT views), shown on every water point's page and on **Try it** |
| NEAR on-chain random seed | `env::random_seed()` draws the households asked to vote, so a mechanic cannot know whom to bribe | `contract/src/lib.rs` (the sample draw, line ~229) |
| near-sdk (Rust) | The pool contract: jobs, one-time-code voting, 70/30 payment, forfeit rule | `contract/` (21 unit tests in `contract/src/tests.rs`) |
| near-kit | The Worker's relayer pays gas and signs calls; the tools sign testnet admin and demo calls | `web/src/worker.js`, `tools/` |
| NEAR wallet (`@hot-labs/near-connect`) | Donors and mechanics sign with their own accounts | `web/src/wallet.js` |
| Multi-signature admin | Registering a mechanic or adding a pump needs both signer accounts to approve the same action | `contract/src/lib.rs` (`approve_action`), `tools/admin.mjs` |
| NEAR RPC and Explorer | The page reads the chain directly over RPC and links every transaction | `web/public/config.json`, `web/public/app.js` |

About the NFT claim, precisely: the contract exposes the NEP-171 read interface for its records (`nft_token`, `nft_total_supply`, a disabled `nft_transfer`). It is not a full NEP-171 collection: there is no minting, no transfer and no royalties, because these are records of water points and households, not tradable assets. A pump's service history is the list of jobs for that pump.

## What NEAR gives, and what would work anywhere

- **The address proves the rules.** A NEAR deterministic account's address is derived from its code and starting state, and it has no keys. The page recomputes that address in the browser, checks over RPC that there are no access keys, that the code is referenced by hash, and that the code stored on-chain is byte-identical to `evidence/borehole_pool.wasm`. This is the strongest NEAR-specific claim here.
- **Measured costs on testnet.** Publishing the 230,074-byte code by hash burned 23.02 NEAR once. Creating the keyless pool from that code cost about 0.01 NEAR in fees.
- **Gasless users.** A relayer pays gas, so villagers never hold NEAR. (This is a plain relayer; NEP-366 meta-transactions are not used. Other chains can do the same with paymasters.)
- **What would work on any chain:** the repair rule itself. An EVM version using a factory, an immutable proxy and a paymaster could do most of it, with less readable accounts and no address-from-code check. We do not claim only NEAR can do this. What NEAR adds is narrower and specific: an address that proves its own code, which a donor can check without trusting the deployer.
- Nested sub-account names (`well-3.<pool>`) were planned and **cut**.

## Prior art, and what is different

Pooled maintenance funds paid by mobile money already work. FundiFix in Kenya pools monthly M-PESA payments across communities, verifies repairs with handle sensors, and reports (and a peer-reviewed Kwale study found) about 90% of repairs within three days; I did not re-check the study myself. A Rwanda trial showed sensor-triggered repair beats scheduled visits. WellKeep does not replace any of that.

What is different: the fund is public and keyless, so a donor can see and check where the money goes without trusting an operator, a committee treasurer or us. I found no independent blockchain water-maintenance pilot; one 2020 IBM/SweetSense blockchain pilot is cited without a known outcome.

## Honest limits

- **A vote is not proof the pump works.** It records that households said so. A sensor is stronger; this is the cheap fallback where sensors are not affordable.
- **The household roll is a one-time trust point.** Two independent signers enrol it. If both are dishonest they can pad it. (On this testnet build both signers are accounts I control.)
- **Cards can be bought or stolen.** Keep each payout below the cost of buying enough codes.
- **Votes are linkable to a card.** Anyone who knows which card is whose can see how it voted. The chain cannot stop pressure on villagers.
- **A held share can be denied by two dishonest households.** Two reports forfeit it. The mechanic has no appeal in this version.
- **No phone coverage means no votes.** About a fifth of rural areas lack signal, and literacy is limited. The design leans on SMS and printed cards; this is untested.
- **Real money.** Nigeria and Kenya tightened stablecoin rules in November 2026, and I found no evidence of rural mechanics using stablecoins. A real deployment needs a licensed off-ramp partner.
- **Donor demand is unproven.** I found no evidence that small donors would fund maintenance over new wells.
- **Not tested with any village.** It needs a field pilot.

## Evidence

- `evidence/verification.json` — the seven checks, run against the live pool.
- `evidence/live-run.json` — an end-to-end run on the previous pool (same code hash, a 2-minute hold; the current pool differs only in a 1-hour hold) with transaction hashes: the 70/30 payment, the forfeit path, and refusals (reused code, unregistered mechanic, price over cap).
- `evidence/publish.json` — code hash, publisher, pool address.
- `evidence/borehole_pool.wasm` and `evidence/state-init.json` — the exact code and starting state the address commits to.
- `contract/` — 21 unit tests (`cargo test`); `tests/` — 6 tests for the card codes and the verifier, including a negative control (the same code deployed the ordinary way, with a key and no hash reference, fails the checks).

## Run it yourself

```bash
# tests
npm install
npm test                                  # JS tests (need internet for 3 of them; npm run test:offline skips those)
cd contract && cargo test --features state-tool

# build the wasm (Linux/WSL, Rust + wasm32 target + binaryen)
bash tools/build.sh

# demo cards, publish and create (testnet; accounts/keys in .keys/, gitignored)
node tools/cards.mjs 30 6
node tools/publish.mjs publish            # burns ~24 testnet NEAR once per code version
node tools/publish.mjs create
node tools/bootstrap.mjs

# the site
node tools/sync-web.mjs                   # bundles the verifier, copies evidence
npx wrangler dev                          # needs .dev.vars: RELAY_KEY (a testnet key)
```

## AI use disclosure

I built this with Claude Code (Anthropic) as a pair-programming agent: the contract, tests, tooling, web app and this README were written with it. The design (donor-first, household cards, random sample, two-stage payment) was worked out in conversation, and the field-evidence section came from a separate research report that I did not independently verify beyond the peer-reviewed sources. Photos in the site are from Wikimedia Commons (credits in the page footer). Libraries: `near-sdk` (Rust), `near-kit`, `esbuild`, `wrangler`. No code from before the hackathon window.

## License

MIT
