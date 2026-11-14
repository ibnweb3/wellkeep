# X long-form post (not posted)

For X's long post / Article format. Attach the demo video (`docs/demo/wellkeep-demo.mp4`) at the top, and put the screenshots at the marked places (`docs/screenshots/`). Rules from the hackathon: say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, attach the video or screenshots.

Title: **A well should be paid to be kept, not only to be built**

---

The borehole at Ugbo was drilled with a donor's money. There was a ribbon, a plaque and a photograph. For two years the handpump gave clean water to about three hundred people.

Then the pump's seal wore out.

A mechanic in the next town would have fixed it for the price of a few bags of cement. But there was no fund to pay him, and nobody in Ugbo could prove to a stranger that the money would be spent on the pump. So the women went back to the stream, a long walk away, and the children who carried the water got sick more often. The plaque is still there.

Ugbo is a village I made up to show the problem. The problem is not made up. About one handpump in four in sub-Saharan Africa is out of order at any time. The money that builds a well is almost never the money that keeps it running.

I built WellKeep for #NEARHackathon, with @NEARProtocol, to fix that one gap: who pays for the repair, and how does a donor know it was spent on the pump?

[video here]

**How it works, in the order a repair happens**

1. Every water point is an NFT and also its own account on NEAR. That account holds the pump's repair money in USDC. Nobody holds a key to it.
2. When the pump breaks, a household reports it with a one-time code from a printed card. They need no wallet and no NEAR; a relayer pays the fee.
3. A registered mechanic quotes a price in USDC. A small quote from a trusted mechanic goes straight through. A mid-size one needs a council member. A large one needs the village committee, which is a real Sputnik DAO where two of three must vote yes.
4. After the repair, the reporter and about eight random households are asked one question: does it work now? NEAR's on-chain random seed chooses who is asked, so nobody can pick the voters.
5. At two thirds yes, the mechanic is paid 70% at once, straight from the pump's own account. The last 30% follows an hour later, unless two different households report the pump broken again.
6. Every report, vote and payment is public. Each job has an invoice that links to the payment on NEAR, and a CSV for the bookkeeper.

[screenshot: invoice WK-0005]

**Why this could only be built on NEAR**

I ask this of every idea I build, and I'd rather answer it honestly: if the core value could run on any chain, the chain isn't central. Here it isn't, because the product *is* four things NEAR gives you:

- **An account with no key.** A NEAR account can exist with no access key at all, so nobody can sign for it. The fund's address is worked out from its code and starting state. In the demo, a "Check before you give" button reads the chain in your own browser and proves it: no keys, the code is the code in the repository, the address recomputes. Nothing there asks you to trust my website.
- **Contract code pinned by its hash.** The fund runs a NEAR global contract referenced by its hash, so even I, the publisher, cannot swap the code after people give.
- **Accounts under accounts.** Each pump is its own keyless sub-account created by the pool, with a 3.9 KB vault whose only method pays the mechanic when the pool says so. The pump's money sits in its own account, not as a number in someone's database.
- **A ready-made committee.** The village committee is a Sputnik DAO, NEAR's standard DAO contract. Approving a big repair is an ordinary DAO proposal. I wrote no new multisig.

Take those away and this is a database with a promise.

[screenshot: pump page with the NFT and its keyless account]

**The NFT does something**

Whoever holds a pump's NFT is its steward: they approve large quotes and set the highest quote the pump will take. Transfer the token and the control moves, while the money stays in the pump's own account. A sale in the middle of a payout still pays the mechanic, because the payee is fixed when they take the job. I tested it with a real transfer on testnet: the old holder was refused, the new steward could act.

**What is proven, and what isn't**

I would rather you hear the limits from me.

- It is a **testnet prototype with test money** (Circle's testnet USDC). It has **not been tested with any real community**.
- The village is invented. The people in the photos have no connection to this project.
- The wallet-signed buttons were pressed from a real wallet on testnet (Meteor): donate, quote, steward approve, post the fix, add a deputy, hand over the NFT. The ledger entries are in the repo.
- If the USDC contract ever refuses a payout, the amount is recorded as owed and anyone can retry it. I proved that on testnet with a token that can refuse.
- Admin keys, the committee council and the relayer are controlled by me in this demo. A real deployment would hand those to the village.
- Real use needs a field partner who knows how pumps are really repaired. That's the part I can't do alone.

**If you work in water, or fund it**

If you run a water charity, fund borehole maintenance, or repair pumps for a living, I would value an hour of your time to tell me where this breaks in a real village. The three things I most want to know: who actually pays the mechanic today, what stops a village from agreeing "it works" when it doesn't, and what a donor would need to see before trusting a fund like this.

Try it with no wallet (the Try page plays every role and sends real testnet transactions):
https://wellkeep.ibnweb3lab.workers.dev

Code (MIT), with the evidence and a 5-minute walkthrough:
https://github.com/ibnweb3/wellkeep

Built at #NEARHackathon with @NEARProtocol. Tracks: NFTs That Do Something, Real-World Money, Social Money.

---

## Notes for you
- Keep the "made up" line. It is what lets the story move people without overclaiming.
- The 1-in-4 figure is from Foster and others (water point data); the source is linked in the README, add the link under the post if you want a citation.
- I did not tag any real charity or funder. Tag some only if you mean to ask them something.
- "The wallet-signed buttons were pressed from a real wallet" is true for the mechanic, steward, donor and NFT-transfer buttons. A deputy approving a mid-size quote from their own wallet was not tried from a wallet (it is proven through the DAO and command line).
