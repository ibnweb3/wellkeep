# X long-form post, final draft (not posted)

Where the three files go (the post marks each spot with a line in square brackets; delete the bracket line and put the file there):
- VIDEO: `docs/demo/wellkeep-demo.mp4`, at the very top, right after the first line.
- IMAGE 1: `docs/screenshots/x-invoice.png`, after "Radical transparency".
- IMAGE 2: `docs/screenshots/x-pump-page.png`, after "Why this could only be built on NEAR".

---

We love funding new wells in Africa 🌍. Too few people fund the few-dollar seal that keeps them alive.

[VIDEO: wellkeep-demo.mp4]

The borehole at Ugbo was drilled with a donor's money. There was a ribbon-cutting, a shiny brass plaque, and a photograph sent back to the people who funded it. For two years, that handpump gave clean water to 300 people.

Then, a rubber seal wore out.

A mechanic in the next town could have fixed it for the price of a few bags of cement. The skill was there. The parts were there.

What wasn't there was a way to pay him, and no way for a village to prove to a stranger thousands of miles away that a small donation would actually go into the pump, and not vanish into thin air.

So the women went back to walking miles to a muddy stream. The children who carried the water started getting sick again.

And the donor's plaque? It is still bolted to the concrete, overlooking a broken pump.

Ugbo is a village I invented to tell this story. The tragedy is not invented. Right now, roughly 1 in 4 handpumps across sub-Saharan Africa is broken. Charity loves a ribbon-cutting, so the money that builds a well is almost never the money that keeps it running.

I built WellKeep for #NEARHackathon with @NEARProtocol to close that exact gap: who pays for the repair, and how does a donor know for a fact it was spent on the pump?

HOW IT WORKS (from broken pump to clean water)

Every well is its own bank account. Each water point is an NFT paired with its own keyless account on NEAR, holding repair funds in USDC. Nobody, not even me, holds a private key that can withdraw it.

Zero-crypto reporting. When a pump breaks, a local household reports it using a one-time code from a printed card. They don't need a wallet, a seed phrase or gas fees; a relayer handles the transaction.

Scaled approvals. A registered mechanic quotes the repair in USDC. Small fixes from trusted mechanics go straight through. Mid-sized quotes need a council member. Major repairs go to a vote by the village committee (a real Sputnik DAO where 2 of 3 must approve).

Hard-to-game verification. Once fixed, the reporter and about 8 random households are asked one question: does it work now? NEAR's on-chain random seed picks the voters, so nobody can choose who is asked.

Escrow-style payout. At two thirds "yes", the mechanic gets 70% immediately, straight from the pump's own account. The final 30% releases an hour later, unless two different households report it broken again.

Radical transparency. Every report, vote and payout is public. Every repair has an invoice linked directly to the on-chain transaction, plus a downloadable CSV for auditors and bookkeepers.

[IMAGE 1: x-invoice.png]

WHY THIS COULD ONLY BE BUILT ON NEAR

Whenever I build in Web3, I ask myself: could this just be a Web2 database? If so, the blockchain is decoration. WellKeep relies on four things NEAR gives you:

Accounts with zero keys. A NEAR account can exist with no access keys at all, so nobody can sign for it. Its address is worked out from its code and starting state. A "Check before you give" button verifies all of that in your browser before you donate. You don't have to trust my website.

Code pinned by hash. The fund runs a global contract referenced by its cryptographic hash. Even as the creator, I cannot silently swap the rules after donors put money in.

Accounts under accounts. Each pump is a keyless sub-account created by the main pool, running a tiny 3.9 KB vault whose only job is to pay a mechanic when the pool says so. The money sits with the pump, not in a pooled company ledger.

Governance out of the box. The village committee is a standard Sputnik DAO. Approving a major repair is an ordinary DAO proposal, with no custom multisig to write.

Take those away, and this is a database with a pinky promise.

[IMAGE 2: x-pump-page.png]

AN NFT WITH AN ACTUAL JOB

Whoever holds a pump's NFT is its steward: they set the highest quote the pump will take and approve large repairs. Transfer the NFT and the control moves, while the USDC stays locked in the pump's own account. Even if the NFT changes hands mid-repair, the mechanic still gets paid, because the payee is locked in when the job starts.

RADICAL HONESTY: WHAT IS PROVEN, AND WHAT ISN'T

If we're talking about real-world aid, I'd rather tell you the limits up front.

It's a prototype. This runs on NEAR testnet with Circle's testnet USDC. It has not been deployed in a real village. The village of Ugbo is invented, and the photos on the site are stock images with no connection to this project.

The plumbing works. Every action was executed on NEAR testnet: donating, quoting, steward approvals, DAO votes and NFT transfers. The wallet-signed ones (donate, quote, approve, post the fix, add a deputy, hand over the NFT) were signed with a real wallet, and the ledger proof is in the repo. Edge cases are handled too: if the USDC contract refuses a payout, it is recorded as owed and can be retried.

Training wheels. In this demo I hold the admin keys, the relayer key and the DAO council accounts. A real deployment would hand those to local governance.

Software isn't enough. Code can hold money, verify hashes and automate payouts, but it cannot fix a pipe. A real deployment needs a field partner who understands rural water maintenance on the ground.

IF YOU WORK IN WATER, OR FUND IT, I WANT TO TALK TO YOU

If you run a water charity, fund borehole projects, or repair handpumps for a living, I would love an hour of your time to tell me where this breaks in the real world.

Try the live demo (no wallet needed, you can play every role):
https://wellkeep.ibnweb3lab.workers.dev

Open-source code (MIT) and a 5-minute walkthrough:
https://github.com/ibnweb3/wellkeep

Built at #NEARHackathon with @NEARProtocol. Tracks: NFTs That Do Something, Real-World Money, Social Money.
