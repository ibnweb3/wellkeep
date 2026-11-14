# Real wallet run (Meteor Wallet, testnet), 2026-11-14

The builder connected `ibnweb3.testnet` through the live site with Meteor Wallet and pressed the buttons below. The only
calls not signed by that wallet are the report and the five votes (household calls, sent through the relayer) and the
admin step that added the account as a mechanic and created pump 6 with that account as steward (both signers).

Pool ledger entries (`list_ledger`), in order, for pump 6 "Wallet test well", job 4:

| Step | Ledger kind | Who | Amount (USDC) |
|---|---|---|---|
| Donate to a pump (first gift, pump 1) | fund | ibnweb3.testnet | 2.00 |
| Donate to pump 6 (twice) | fund | ibnweb3.testnet | 3.00, 3.00 |
| Mechanic sends a quote (wallet) | quote | ibnweb3.testnet | 2.50 |
| Steward approves the quote (wallet) | steward_ok, accept | ibnweb3.testnet | 2.50 |
| Mechanic posts the fix (wallet) | fix_posted | ibnweb3.testnet | |
| Five household votes (relayer) | vote | hh-50, 40, 145, 41, 74 | |
| First payment, 70%, from the pump's vault | pay_first | ibnweb3.testnet | 1.75 |
| Steward adds a deputy (wallet) | deputy_added | ibnweb3.testnet -> bh-council-1.testnet | |
| Steward hands the pump NFT over (wallet) | nft_transfer | bh-council-1.testnet (new holder) | |

After the run: `get_pump(6)` shows steward `bh-council-1.testnet`, and `nft_tokens_for_owner("bh-council-1.testnet")`
lists `pump-6`. The held 0.75 USDC releases after the one-hour hold.
