const id = process.argv[2];
const r = await fetch("https://test.rpc.fastnear.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }) }).then((x) => x.json());
console.log(JSON.stringify(r.result ?? r.error));
