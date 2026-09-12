// test.mjs — FULL on-chain AI lifecycle test for PredictionMarketResolver v2.
//
// stake -> permissionless resolve (binding-verified web evidence, real
// consensus) -> mandatory dispute window -> dispute -> permissionless
// resolve_dispute -> settle (permissionless) -> claim; plus the recovery
// path (empty winning side -> auto-void -> refund) and gating reverts.
//
// Where a PRIVATE_KEY2 stranger account is available (see
// _fund_stranger.mjs), the permissionless steps are executed by an account
// that is NOT the market creator.
//
// Usage: node --env-file=.env test.mjs [--direct]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { setup, robust, result, clean, parseJson, sleep, callTx } from "./common.mjs";

const { client, accountAddress } = await setup({ needAddress: false });

let strangerClient = null, strangerAddr = null;
const key2 = ((readFileSync(".env", "utf8").match(/^PRIVATE_KEY2=0x[0-9a-fA-F]{64}$/m) || [""])[0] || "").replace(/^PRIVATE_KEY2=/, "");
if (key2) {
  const acct = createAccount(key2);
  strangerClient = createClient({ chain: testnetBradbury, account: acct });
  strangerAddr = acct.address;
  console.log("stranger account:", strangerAddr, "(permissionless calls will use it)");
} else {
  console.log("no PRIVATE_KEY2 — permissionless calls fall back to the creator account");
}
const who = (label) => (strangerClient ? label + " [by STRANGER]" : label + " [by creator — no stranger key]");

// Real, verifiable market: HTCPCP defines 418 as "I'm a teapot" — two
// independent immutable sources, each with a verbatim binding excerpt.
const QUESTION = "According to the cited sources, does the Hyper Text Coffee Pot Control Protocol (HTCPCP) define the HTTP status code 418 as \"I'm a teapot\"?";
const RULES = "Resolve YES if the admissible evidence clearly states that HTCPCP defines HTTP status code 418 as \"I'm a teapot\". Resolve NO if it clearly states otherwise. Otherwise UNRESOLVED.";
const S1 = "https://www.rfc-editor.org/rfc/rfc2324.txt";
const B1 = "Any attempt to brew coffee with a teapot should result in the error code \"418 I'm a teapot\"";
const S2 = "https://en.wikipedia.org/wiki/Hyper_Text_Coffee_Pot_Control_Protocol";
const B2 = "The Hyper Text Coffee Pot Control Protocol (HTCPCP) is a facetious communication protocol for controlling, monitoring, and diagnosing coffee pots";

const STAKE = 1000000000000000n; // 0.001 GEN
const W = 1200; // dispute window, seconds (consensus rounds take 2-10 min)

let pass = 0, fail = 0, evidence = [];
const ok = (name, cond) => {
  if (cond) { pass++; console.log("PASS:", name); evidence.push("PASS " + name); }
  else { fail++; console.log("FAIL:", name); evidence.push("FAIL " + name); }
};
const isErr = (r) => r === "FINISHED_WITH_ERROR" || r === "REVERTED" || r === "SUBMIT_TIMEOUT" || r === "NOT_VOTED" || r === "UNDETERMINED" || r === "LEADER_TIMEOUT";
// get_state returns a typed dict (decoded to an object); older states are
// JSON strings. Normalize + retry until the state is readable.
const read = async (addr) => {
  for (let i = 0; i < 20; i++) {
    const raw = await robust("state read", () =>
      client.readContract({ address: addr, functionName: "get_state", args: [] }));
    const st = (raw && typeof raw === "object") ? raw : parseJson(raw);
    if (st && st.status) return st;
    await sleep(4000);
  }
  throw new Error("state unreadable for " + addr);
};
const waitUntil = async (t, label) => {
  const remain = t - Math.floor(Date.now() / 1000);
  if (remain > 0) { console.log("waiting " + remain + "s for " + label + "..."); await sleep(remain * 1000 + 5000); }
};
const waitForStatus = async (addr, from, label) => {
  for (let i = 0; i < 120; i++) {
    const s = await read(addr);
    if (s && s.status !== from) return s;
    await sleep(5000);
  }
  return await read(addr);
};

const source = readFileSync(new URL("./contracts/prediction_market.py", import.meta.url), "utf8");
const code = new TextEncoder().encode(source);

async function deployMarket(id, sd, fd) {
  const args = [QUESTION, RULES, S1, S2, "", B1, B2, "", id, W, sd, fd];
  const h = await robust("deploy", () => client.deployContract({ code, args }));
  await robust("deploy wait", () => client.waitForTransactionReceipt({ hash: h, status: TransactionStatus.ACCEPTED, retries: 300 }));
  const tx = await robust("deploy read", () => client.getTransaction({ hash: h }));
  const addr = tx?.txDataDecoded?.contractAddress ?? tx?.recipient;
  console.log("market", id, "->", addr, "(", tx?.txExecutionResultName, ")");
  return addr;
}

// stranger-aware call helper: prefers the stranger client when instructed
async function callAs(stranger, addr, fn, args, value) {
  if (stranger && strangerClient) {
    const h = await robust(fn + " submit", () =>
      strangerClient.writeContract({ address: addr, functionName: fn, args, value: value || 0n }));
    const t = await result(strangerClient, h);
    console.log("  " + fn + " [stranger] -> " + t?.txExecutionResultName + " (tx " + h + ")");
    return t?.txExecutionResultName;
  }
  const r = await callTx(client, addr, fn, args, value);
  return r.result;
}

console.log("=== L: full AI lifecycle market ===");
const NOW = Math.floor(Date.now() / 1000);
const SD = NOW + 900;    // staking closes in 15 minutes (consensus is slow)
const FD = NOW + 86400;  // hard exit in 24 hours
const L = await deployMarket("htcpcp-lifecycle-" + Date.now(), SD, FD);

const r1 = await callTx(client, L, "stake", ["YES"], STAKE);
ok("T1 stake YES accepted", clean(r1.result));

await waitUntil(SD, "staking deadline");
console.log("--- " + who("resolve") + " ---");
const r2 = await callAs(true, L, "resolve", []);
const s2 = await waitForStatus(L, "open", "resolution");
ok("T2 " + who("permissionless resolve") + " accepted", !isErr(r2));
ok("T2 resolved YES with verified bindings -> dispute_window",
  s2.status === "dispute_window" && s2.outcome === "YES",
  );
evidence.push("resolve outcome: " + s2.outcome + " status: " + s2.status);
console.log("resolve outcome:", s2.outcome, "status:", s2.status);
ok("T2 mandatory dispute window armed",
  Number(s2.dispute_deadline) === Number(s2.resolve_time) + W);

const r3 = await callTx(client, L, "settle", []);
ok("T3 settle during dispute window reverts", isErr(r3.result));

const r4 = await callTx(client, L, "dispute", ["Please re-check the binding-verified sources before settlement."]);
const s4 = await waitForStatus(L, "dispute_window", "dispute");
ok("T4 staker dispute accepted -> disputed", !isErr(r4) && s4.status === "disputed");

console.log("--- " + who("resolve_dispute") + " ---");
const r5 = await callAs(true, L, "resolve_dispute", []);
const s5 = await waitForStatus(L, "disputed", "dispute resolution");
ok("T5 " + who("permissionless resolve_dispute") + " accepted -> dispute_resolved",
  !isErr(r5) && s5.status === "dispute_resolved");
evidence.push("dispute outcome: " + s5.dispute_outcome);

const dl = Number((await read(L)).dispute_deadline);
await waitUntil(dl, "dispute window to close");
console.log("--- " + who("settle") + " ---");
const r6 = await callAs(true, L, "settle", []);
const s6 = await read(L);
ok("T6 " + who("permissionless settle") + " accepted -> settled YES",
  !isErr(r6) && s6.status === "settled" && s6.winning_side === "YES");

const r7 = await callTx(client, L, "claim", []);
ok("T7 winner claim accepted", clean(r7.result));
const s7 = await read(L);
const myClaim = parseJson(s7.claims)?.[String(accountAddress)];
ok("T7 payout equals full pool (single staker)",
  myClaim && myClaim.claimed === true && Number(myClaim.payout) === Number(STAKE));
const r8 = await callTx(client, L, "claim", []);
ok("T8 double claim reverts", isErr(r8.result));

console.log("=== R: recovery path (empty winning side -> auto-void -> refund) ===");
const NOW2 = Math.floor(Date.now() / 1000);
const R = await deployMarket("htcpcp-recovery-" + Date.now(), NOW2 + 600, NOW2 + 86400);
const rr1 = await callTx(client, R, "stake", ["NO"], STAKE);
ok("T9 stake NO only (YES side stays empty)", clean(rr1.result));
await waitUntil(NOW2 + 180, "staking deadline");
const rr2 = await callAs(true, R, "resolve", []);
const rs2 = await waitForStatus(R, "open", "resolution");
ok("T10 resolve -> YES (winning side empty)", !isErr(rr2) && rs2.status === "dispute_window" && rs2.outcome === "YES");
const rdl = Number((await read(R)).dispute_deadline);
await waitUntil(rdl, "recovery dispute window");
const rr3 = await callAs(true, R, "settle", []);
const rs3 = await read(R);
ok("T11 settle -> auto-void (winning_side_empty)", !isErr(rr3) && rs3.status === "voided" && rs3.void_reason === "winning_side_empty");
const rr4 = await callTx(client, R, "refund", []);
ok("T12 refund 1:1 after auto-void", clean(rr4.result));

console.log("=== G: gating reverts (market without stakes) ===");
const NOW3 = Math.floor(Date.now() / 1000);
const G = await deployMarket("htcpcp-gating-" + Date.now(), NOW3 + 3600, NOW3 + 86400);
const g1 = await callTx(client, G, "stake", ["YES"], 0n);
ok("T13 zero-value stake reverts", isErr(g1.result));
const g2 = await callTx(client, G, "claim", []);
ok("T14 claim before settle reverts", isErr(g2.result));
const g3 = await callTx(client, G, "dispute", ["too early"]);
ok("T15 dispute before resolve reverts", isErr(g3.result));
const g4 = await callAs(true, G, "resolve", []);
ok("T16 resolve with no stakers reverts", isErr(g4));

console.log("");
console.log("---");
console.log("PASS: " + pass + " FAIL: " + fail);
evidence.push("", "PASS: " + pass + " FAIL: " + fail,
  "lifecycle market: " + L, "recovery market: " + R, "gating market: " + G,
  "run at: " + new Date().toISOString());
writeFileSync("test-results.txt", evidence.join("\n") + "\n");
console.log("saved test-results.txt");
process.exit(fail === 0 ? 0 : 1);
