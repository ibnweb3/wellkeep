// The village committee as a Sputnik DAO on testnet (existing sputnikv2.testnet factory): it will hold the
// pump NFTs, so approving a big quote is an ordinary DAO proposal that the council votes on. Testnet only.
//   node tools/dao.mjs create                       -> creates wellkeep-village.sputnikv2.testnet with 3 council accounts
//   node tools/dao.mjs propose <pool> <method> <argsJson>   -> council-1 files a FunctionCall proposal on the pool
//   node tools/dao.mjs vote <proposalId>            -> council-2 and council-3 vote yes (executes at 2 of 3)
//   node tools/dao.mjs show                         -> policy and last proposals
import { nearFor, viewer, sleep } from "./lib.mjs";
import { call } from "./pool.mjs";

const FACTORY = "sputnikv2.testnet";
const NAME = "wellkeep-village";
export const DAO = `${NAME}.${FACTORY}`;
const COUNCIL = ["bh-council-1.testnet", "bh-council-2.testnet", "bh-council-3.testnet"];
const cmd = process.argv[2];

if (cmd === "create") {
  const args = {
    config: {
      name: NAME,
      purpose: "Village committee for WellKeep water points. Holds the pump NFTs; approving a large repair quote is a proposal the council votes on.",
      metadata: "",
    },
    policy: COUNCIL,
  };
  const out = await call(nearFor("bh-deployer-1113.testnet"), FACTORY, "create", { name: NAME, args: Buffer.from(JSON.stringify(args)).toString("base64") }, "6 NEAR");
  console.log("create ->", JSON.stringify(out?.status).slice(0, 120));
  await sleep(5000);
  console.log("policy", JSON.stringify(await viewer().view(DAO, "get_policy", {})).slice(0, 700));
} else if (cmd === "propose") {
  const [, , , pool, method, argsJson] = process.argv;
  const out = await call(
    nearFor(COUNCIL[0]),
    DAO,
    "add_proposal",
    {
      proposal: {
        description: `Call ${method} on the WellKeep pool`,
        kind: { FunctionCall: { receiver_id: pool, actions: [{ method_name: method, args: Buffer.from(argsJson ?? "{}").toString("base64"), deposit: "0", gas: "60000000000000" }] } },
      },
    },
    "1 NEAR",
  );
  console.log("proposal ->", out?.status?.SuccessValue ? Buffer.from(out.status.SuccessValue, "base64").toString() : JSON.stringify(out?.status).slice(0, 200));
} else if (cmd === "vote") {
  const id = Number(process.argv[3]);
  for (const c of COUNCIL.slice(1)) {
    try {
      const out = await call(nearFor(c), DAO, "act_proposal", { id, action: "VoteApprove" });
      console.log(c, "voted;", JSON.stringify(out?.status).slice(0, 80));
    } catch (e) {
      console.log(c, "vote:", String(e.panic ?? e.message).slice(0, 120));
    }
  }
  console.log("proposal now", JSON.stringify(await viewer().view(DAO, "get_proposal", { id })).slice(0, 400));
} else if (cmd === "show") {
  console.log("policy", JSON.stringify(await viewer().view(DAO, "get_policy", {})).slice(0, 800));
  console.log("last proposal id", await viewer().view(DAO, "get_last_proposal_id", {}));
} else {
  console.error("usage: node tools/dao.mjs create|propose|vote|show");
}
