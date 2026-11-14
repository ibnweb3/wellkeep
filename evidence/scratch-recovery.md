# Failed-payout recovery, proven on testnet with a token that can refuse

Run with `MOCK=<mock wasm> node tools/scratch-v2.mjs` (a throwaway pool on a throwaway account, deleted afterwards; a
throwaway NEP-141 that can be told to refuse transfers to one account). Circle's real USDC cannot be made to refuse a
registered account on demand, so this proof uses the mock token. The contract code is the published code.

Output of the recovery part of the run (2026-11-14):

```
owed after the token refused: [{"id":0,"kind":"first","amount":"700000","to":"bh-mechanic.testnet","state":"Open"}]
pump 1 paid_total (should be 0): 0 | vault still holds 3
after the retry: Paid | mechanic USDC + 0.70 (expected 0.70) | pump 1 paid_total 700000
recovery ledger entries: pay_failed_first, pay_retry, pay_recovered
```

What it shows: the token refused a 0.70 USDC payout; the pool recorded it as owed (state Open) instead of losing it;
the money stayed in the pump's vault and the pump's paid total did not count it; after the token accepted the payee
again, `retry_payment` paid the mechanic 0.70 USDC and the totals were restored; the ledger has the three entries.
Unit tests (`contract/src/tests.rs`) also cover a failed retry reopening the payment, a second retry being refused
while one is in flight, and both signers reassigning a payment to another account.
