# NEAR HACKATHON submission: exact answers (NOT sent)

Form: https://nearhackathon.com/#apply (cannot be edited after sending; changes go through https://nearhackathon.com/request-changes).

| Field | Answer |
|---|---|
| Project name (max 80) | WellKeep |
| Team lead (max 80) | TO CONFIRM |
| Email (max 160) | TO CONFIRM |
| Team size | 1 - Solo builder |
| Tracks | NFTs That Do Something; Real-World Money; Social Money |
| NEAR wallet address (max 64) | TO CONFIRM (your MAINNET account; the prize is sent here) |
| Repository link | https://github.com/ibnweb3/wellkeep |
| Demo post link | TO FILL after the X Article is published |
| Consent checkbox | tick |

## What did you build? (max 2000)

Ugbo, an invented village, gets a borehole from a donor, and two years later a rubber seal wears out. A mechanic could fix it, but there is no fund to pay him and no way for the donor to know the money would reach the pump. About one handpump in four in sub-Saharan Africa is broken at any time. WellKeep is a repair fund for every water point, built on NEAR.

Each water point is an NEP-171 NFT and also its own keyless NEAR account holding repair money in Circle's USDC. A household reports a broken pump with a one-time code from a printed card (no wallet; a relayer pays gas). A registered mechanic quotes in USDC: small quotes go straight through, mid-size ones need a council member, large ones need the village committee, a real Sputnik DAO (2 of 3). After the fix, the reporter and about eight households chosen by NEAR's on-chain random seed are asked "does it work now?". At two thirds yes the mechanic is paid 70% at once from the pump's own account and 30% an hour later, unless the pump breaks again. Every report, vote and payment is public, with an invoice that links to the transaction and a CSV export. A payout the USDC contract refuses is recorded as owed and can be retried.

NEAR is central: the fund is a keyless account whose address is derived from its code, running a global contract pinned by hash, so even I cannot swap the rules. Each pump is a keyless sub-account with a 3.9 KB vault, and a "Check before you give" button proves all of this in the browser. Holding a pump's NFT makes you its steward, and transferring it moves control while the money stays in the pump's account.

Honest limits: testnet with test USDC, an invented village, no field test, and I hold the admin, relayer and council keys in this demo. Wallet-signed actions (donate, quote, approve, post fix, add deputy, NFT transfer) were done with a real wallet; the evidence is in the repository.
