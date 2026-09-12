// deploy.mjs — deploy contracts/prediction_market.py (v2) to GenLayer Bradbury
// and open the showcase market.
//
// v2 hardening (steward review):
//   * sources are immutable from creation, >= 2 different registrable domains,
//     each bound to a verbatim binding excerpt (semantic anchor);
//   * the lifecycle is permissionless (resolve / resolve_dispute / settle /
//     void / finalize can be called by ANY account) and finalize() is the
//     hard-deadline exit, so funds can never stay locked.
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// (DPI workaround). Pass --direct for the plain network path.
//
// Usage: node --env-file=.env deploy.mjs [--direct]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { TransactionStatus } from "genlayer-js/types";
import { setup, robust, clean } from "./common.mjs";

const { client, accountAddress } = await setup({ needAddress: false });

try {
  await robust("consensus init", () => client.initializeConsensusSmartContract());
  console.log("consensus init ok");
} catch (e) {
  console.log("consensus init skipped:", e && e.message ? e.message : String(e));
}

const source = readFileSync(new URL("./contracts/prediction_market.py", import.meta.url), "utf8");
const code = new TextEncoder().encode(source);

// Showcase market: a real, verifiable question over two independent,
// immutable sources, each anchored by a verbatim binding excerpt that the
// contract re-verifies on every node during resolution.
const QUESTION = "According to the cited sources, does the Hyper Text Coffee Pot Control Protocol (HTCPCP) define the HTTP status code 418 as \"I'm a teapot\"?";
const RULES = "Resolve YES if the admissible evidence clearly states that HTCPCP defines HTTP status code 418 as \"I'm a teapot\". Resolve NO if it clearly states otherwise. Otherwise UNRESOLVED.";
const SOURCE1 = "https://www.rfc-editor.org/rfc/rfc2324.txt";
const BINDING1 = "Any attempt to brew coffee with a teapot should result in the error code \"418 I'm a teapot\"";
const SOURCE2 = "https://en.wikipedia.org/wiki/Hyper_Text_Coffee_Pot_Control_Protocol";
const BINDING2 = "The Hyper Text Coffee Pot Control Protocol (HTCPCP) is a facetious communication protocol for controlling, monitoring, and diagnosing coffee pots";
const SOURCE3 = "";
const BINDING3 = "";
const MARKET_ID = "htcpcp-418-teapot";
const DISPUTE_WINDOW_SECONDS = Number(process.env.DISPUTE_WINDOW_SECONDS || 3600);
const NOW = Math.floor(Date.now() / 1000);
const STAKING_DEADLINE = NOW + 24 * 3600;      // trading closes in 24h
const FINAL_DEADLINE = NOW + 7 * 24 * 3600;    // hard exit no later than in 7d

const args = [QUESTION, RULES, SOURCE1, SOURCE2, SOURCE3,
              BINDING1, BINDING2, BINDING3, MARKET_ID,
              DISPUTE_WINDOW_SECONDS, STAKING_DEADLINE, FINAL_DEADLINE];

console.log("deploying PredictionMarketResolver v2 (" + source.length + " chars) from", accountAddress);
console.log("market:", MARKET_ID, "| staking deadline:", STAKING_DEADLINE, "| final deadline:", FINAL_DEADLINE);

const txHash = await robust("deploy submit", () => client.deployContract({ code, args }));
console.log("deploy tx:", txHash);
writeFileSync("deploy-tx.txt", String(txHash) + "\n");

await robust("deploy wait", () => client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.ACCEPTED, retries: 300 }));
const tx = await robust("deploy read", () => client.getTransaction({ hash: txHash }));
const address = tx?.txDataDecoded?.contractAddress ?? tx?.recipient;

console.log("=== DEPLOY RESULT ===");
console.log("statusName:", tx?.statusName);
console.log("txExecutionResultName:", tx?.txExecutionResultName);
console.log("contract address:", address);
const ok = clean(tx);
console.log(ok ? ">>> CLEAN DEPLOY OK" : ("!!! WARNING: execution not clean -> " + tx?.txExecutionResultName));
if (!ok) process.exit(1);

writeFileSync("contract.txt", String(address) + "\n");
let env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
env = env.replace(/^CONTRACT_ADDRESS=.*$/m, "").replace(/\n{3,}/g, "\n\n").trimEnd();
env += "\nCONTRACT_ADDRESS=" + address + "\n";
writeFileSync(".env", env);
console.log("saved: contract.txt, deploy-tx.txt, CONTRACT_ADDRESS in .env");
console.log("Explorer: https://explorer-bradbury.genlayer.com/contract-address/" + address);
console.log(">>> DEPLOYED");
