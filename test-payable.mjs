// test-payable.mjs — DETERMINISTIC on-chain tests for PredictionMarketResolver
// v2 (no LLM involved: every consensus round here either must fail at an
// assert BEFORE any nondeterministic call, or must not call _resolve_now).
//
// Bradbury consensus rounds currently take 2-10 minutes each, so the test
// uses two markets with deliberately separated time windows:
//   * market A — staking deadline +1h, final deadline +24h: asserts that are
//     expected to REVERT stay guaranteed "too early" for the whole run
//     (zero-value stake, valid stake accepted, resolve too early, finalize
//     too early);
//   * market C — staking deadline +20m, final deadline +25m: a stake lands
//     inside the window, then after the deadlines pass: late stake reverts,
//     the STRANGER (non-creator) account calls finalize() -> deadline_void,
//     the staker refunds 1:1, double refund reverts.
//   * markets V1/V2 — creation validation: single-domain sources and missing
//     binding excerpts are rejected on-chain.
//
// Usage: node --env-file=.env test-payable.mjs [--direct]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { setup, robust, result, clean, parseJson, sleep, callTx } from "./common.mjs";

const { client, accountAddress } = await setup({ needAddress: false });

// Stranger account (funded via _evm_transfer.mjs): proves permissionless
// finalize() on-chain from an account that is NOT the market creator.
let strangerClient = null, strangerAddr = null;
const key2 = ((readFileSync(".env", "utf8").match(/^PRIVATE_KEY2=0x[0-9a-fA-F]{64}$/m) || [""])[0] || "").replace(/^PRIVATE_KEY2=/, "");
if (key2) {
  const acct = createAccount(key2);
  strangerClient = createClient({ chain: testnetBradbury, account: acct });
  strangerAddr = acct.address;
  console.log("stranger account:", strangerAddr);
} else {
  console.log("no PRIVATE_KEY2 in .env — finalize will be called by the creator account");
}

const STAKE = 1000000000000000n; // 0.001 GEN
let pass = 0, fail = 0, evidence = [];
const ok = (name, cond) => {
  if (cond) { pass++; console.log("PASS:", name); evidence.push("PASS " + name); }
  else { fail++; console.log("FAIL:", name); evidence.push("FAIL " + name); }
};
const isErr = (r) => r === "FINISHED_WITH_ERROR" || r === "REVERTED" || r === "SUBMIT_TIMEOUT";
// get_state returns a typed dict (an object); retry until a fresh state with
// the given status is visible (state reads can lag behind the accepted tx).
const read = async (addr, wantStatus) => {
  for (let i = 0; i < 60; i++) {
    const raw = await robust("state read", () =>
      client.readContract({ address: addr, functionName: "get_state", args: [] }));
    const st = (raw && typeof raw === "object") ? raw : parseJson(raw);
    if (st && st.status && (!wantStatus || st.status === wantStatus)) return st;
    await sleep(10000);
  }
  throw new Error("state unreadable for " + addr);
};
const waitUntil = async (t, label) => {
  const remain = t - Math.floor(Date.now() / 1000);
  if (remain > 0) { console.log("waiting " + remain + "s for " + label + "..."); await sleep(remain * 1000 + 10000); }
};

const source = readFileSync(new URL("./contracts/prediction_market.py", import.meta.url), "utf8");
const code = new TextEncoder().encode(source);

async function deployMarket(s1, s2, b1, b2, sd, fd, id) {
  const QUESTION = "Deterministic gating market: do the cited sources exist?";
  const RULES = "Resolve YES if the admissible evidence clearly shows the sources exist. Otherwise UNRESOLVED.";
  const args = [QUESTION, RULES, s1, s2, "", b1, b2, "", id || ("gating-" + Date.now()), 120, sd, fd];
  const h = await robust("deploy", () => client.deployContract({ code, args }));
  await robust("deploy wait", () => client.waitForTransactionReceipt({ hash: h, status: TransactionStatus.ACCEPTED, retries: 300 }));
  const tx = await robust("deploy read", () => client.getTransaction({ hash: h }));
  const addr = tx?.txDataDecoded?.contractAddress ?? tx?.recipient;
  return { addr, result: tx?.txExecutionResultName, hash: h };
}

console.log("=== Market A: far deadlines — 'too early' gates stay deterministic ===");
const NOW = Math.floor(Date.now() / 1000);
const A_SD = NOW + 3600;    // staking closes in 1 hour
const A_FD = NOW + 86400;   // hard exit in 24 hours
const A = await deployMarket("https://httpbin.org/json", "https://example.org/",
  "Sample Slide Show", "Example Domain — for use in illustrative examples in documents", A_SD, A_FD, "gating-A-" + Date.now());
console.log("A:", A.addr, "->", A.result);
ok("A1 deploy clean", clean(A.result));

const stA = await read(A.addr);
ok("A1 sources frozen AT BIRTH (before any stake)", stA.sources_frozen === true);
ok("A1 two sources stored", parseJson(stA.frozen_sources)?.length === 2);
ok("A1 config hash present", typeof stA.frozen_config_hash === "string" && stA.frozen_config_hash.length === 64);
ok("A1 deadlines stored", Number(stA.staking_deadline) === A_SD && Number(stA.final_deadline) === A_FD);

const a2 = await callTx(client, A.addr, "stake", ["YES"], 0n);
ok("A2 zero-value stake reverts", isErr(a2.result));
const a3 = await callTx(client, A.addr, "stake", ["YES"], STAKE);
ok("A3 stake within window accepted", clean(a3.result));
const stA3 = await read(A.addr);
ok("A3 position recorded + staking started", stA3.staking_started === true && Number(stA3.yes_pool) === Number(STAKE));
const a4 = await callTx(client, A.addr, "resolve", []);
ok("A4 resolve before staking deadline reverts", isErr(a4.result));
const a5 = await callTx(client, A.addr, "finalize", []);
ok("A5 finalize before final deadline reverts", isErr(a5.result));

console.log("=== Market C: near deadlines — permissionless deadline exit ===");
const NOWC = Math.floor(Date.now() / 1000);
const C_SD = NOWC + 1200;  // staking closes in 20 minutes
const C_FD = NOWC + 1500;  // hard exit in 25 minutes
const C = await deployMarket("https://httpbin.org/json", "https://example.org/",
  "Sample Slide Show", "Example Domain — for use in illustrative examples in documents", C_SD, C_FD, "gating-C-" + Date.now());
console.log("C:", C.addr, "->", C.result);
ok("C1 deploy clean", clean(C.result));
const c1 = await callTx(client, C.addr, "stake", ["YES"], STAKE);
ok("C1 stake lands inside the window", clean(c1.result));

await waitUntil(C_SD, "staking deadline of C");
const c2 = await callTx(client, C.addr, "stake", ["NO"], STAKE);
ok("C2 stake after staking deadline reverts", isErr(c2.result));

await waitUntil(C_FD, "final deadline of C");
let c3;
if (strangerClient) {
  console.log("calling finalize() from the STRANGER account", strangerAddr, "(not the creator)...");
  const h = await robust("finalize submit", () =>
    strangerClient.writeContract({ address: C.addr, functionName: "finalize", args: [] }));
  const t = await result(strangerClient, h);
  c3 = t?.txExecutionResultName;
  console.log("  finalize [stranger] -> " + c3 + " (tx " + h + ")");
} else {
  c3 = (await callTx(client, C.addr, "finalize", [])).result;
}
ok("C3 finalize by non-creator account accepted", clean(c3));
const stC3 = await read(C.addr, "voided");
ok("C3 market voided with deadline_void", stC3.status === "voided" && stC3.void_reason === "deadline_void");

const c4 = await callTx(client, C.addr, "refund", []);
ok("C4 refund 1:1 after deadline exit", clean(c4.result));
const stC4 = await read(C.addr);
const myClaim = (stC4.claims && typeof stC4.claims === "object" ? stC4.claims : parseJson(stC4.claims) || {})?.[String(accountAddress)];
ok("C4 refund recorded with full stake", myClaim && myClaim.claimed === true && Number(myClaim.payout) === Number(STAKE));
const c5 = await callTx(client, C.addr, "refund", []);
ok("C5 double refund reverts", isErr(c5.result));

console.log("=== Creation validation (on-chain) ===");
const NOWV = Math.floor(Date.now() / 1000);
const v1 = await deployMarket("https://httpbin.org/json", "https://httpbin.org/html",
  "Sample Slide Show", "Moby-Dick; Or the Whale", NOWV + 3600, NOWV + 86400, "gating-V1-" + Date.now());
ok("V1 single-domain sources rejected at creation", isErr(v1.result));
const v2 = await deployMarket("https://httpbin.org/json", "https://example.org/",
  "", "Example Domain — for use in illustrative examples in documents", NOWV + 3600, NOWV + 86400, "gating-V2-" + Date.now());
ok("V2 missing binding excerpt rejected at creation", isErr(v2.result));

console.log("");
console.log("---");
console.log("PASS: " + pass + " FAIL: " + fail);
evidence.push("", "PASS: " + pass + " FAIL: " + fail,
  "market A: " + A.addr, "market C: " + C.addr,
  "stranger finalize caller: " + (strangerAddr || accountAddress),
  "run at: " + new Date().toISOString());
writeFileSync("test-payable-results.txt", evidence.join("\n") + "\n");
console.log("saved test-payable-results.txt");
process.exit(fail === 0 ? 0 : 1);
