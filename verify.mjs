// verify.mjs — byte-for-byte parity proof of the deployed market contract.
//
// The deployed code must be IDENTICAL to contracts/prediction_market.py.
// Fetches the deploy tx calldata via eth_call getTransactionData on the
// consensus data contract, RLP-decodes it, and compares sha256 of both
// sides byte-for-byte. Writes parity-proof.txt on success. Read-only.
//
// Usage: node verify.mjs [--tx <deploy_tx_hash>] [--direct]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { installFetchRelay } from "./rpc-relay.mjs";
import { fromRlp, isHex, encodeFunctionData, decodeFunctionResult } from "viem";
import { testnetBradbury } from "genlayer-js/chains";
import { sleep, robust } from "./common.mjs";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf("--" + name);
  return (i !== -1 && args[i + 1]) ? args[i + 1] : null;
}

const RPC_URL = "https://rpc-bradbury.genlayer.com/";
const LOCAL_SOURCE = readFileSync(new URL("./contracts/prediction_market.py", import.meta.url), "utf8");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

if (!args.includes("--direct")) {
  installFetchRelay();
  console.log("waiting 8s for the browser relay tab...");
  await sleep(8000);
}

let deployTx = arg("tx");
if (!deployTx) {
  try { deployTx = readFileSync("deploy-tx.txt", "utf8").trim(); } catch { deployTx = ""; }
}
if (!deployTx) throw new Error("no deploy tx: run deploy.mjs first (or pass --tx <hash>)");

const ABI = testnetBradbury.consensusDataContract.abi;
const calldata = encodeFunctionData({
  abi: ABI,
  functionName: "getTransactionData",
  args: [deployTx, BigInt(Math.round(Date.now() / 1000))],
});
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [{ to: testnetBradbury.consensusDataContract.address, data: calldata }, "latest"],
});

console.log("deploy tx :", deployTx);
console.log("local     :", Buffer.byteLength(LOCAL_SOURCE, "utf8"), "bytes, sha256", sha256(LOCAL_SOURCE));

const resp = await robust("eth_call getTransactionData", () =>
  fetch(RPC_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
const rpcText = await resp.text();
let json;
try { json = JSON.parse(rpcText); } catch (e) { throw new Error("RPC result is not JSON: " + String(e.message).slice(0, 120)); }
if (json.error) throw new Error("RPC error: " + JSON.stringify(json.error).slice(0, 300));

let txData = null;
try {
  const decoded = decodeFunctionResult({ abi: ABI, functionName: "getTransactionData", data: json.result });
  const struct = Array.isArray(decoded) ? decoded[0] : decoded;
  txData = struct && struct.txCalldata ? struct.txCalldata : null;
} catch (e) {
  throw new Error("decodeFunctionResult failed: " + String(e.message).slice(0, 160));
}
if (!txData || !isHex(txData) || txData === "0x") throw new Error("no txCalldata in result");

const rlp = fromRlp(txData);
if (!Array.isArray(rlp) || rlp.length !== 3) {
  throw new Error("unexpected RLP structure, length=" + (Array.isArray(rlp) ? rlp.length : typeof rlp));
}
const deployedCode = Buffer.from(rlp[0].slice(2), "hex").toString("utf8");
console.log("deployed  :", Buffer.byteLength(deployedCode, "utf8"), "bytes, sha256", sha256(deployedCode));
console.log("");

if (deployedCode !== LOCAL_SOURCE) {
  const n = Math.min(deployedCode.length, LOCAL_SOURCE.length);
  let d = -1;
  for (let i = 0; i < n; i++) { if (deployedCode[i] !== LOCAL_SOURCE[i]) { d = i; break; } }
  if (d === -1) d = n;
  console.log("!!! PARITY FAILED: first difference at byte " + d);
  console.log("  local    ...[" + LOCAL_SOURCE.slice(Math.max(0, d - 40), d + 40).replace(/\n/g, "\\n") + "]...");
  console.log("  deployed ...[" + deployedCode.slice(Math.max(0, d - 40), d + 40).replace(/\n/g, "\\n") + "]...");
  process.exit(1);
}

const proof =
  "deploy tx: " + deployTx + "\n" +
  "local    sha256: " + sha256(LOCAL_SOURCE) + " (" + Buffer.byteLength(LOCAL_SOURCE, "utf8") + " bytes)\n" +
  "deployed sha256: " + sha256(deployedCode) + " (" + Buffer.byteLength(deployedCode, "utf8") + " bytes)\n" +
  "PARITY OK: deployed contract code is byte-for-byte identical to contracts/prediction_market.py\n" +
  "verified at: " + new Date().toISOString() + "\n";
writeFileSync("parity-proof.txt", proof);
console.log(">>> PARITY OK: deployed contract code is byte-for-byte identical to contracts/prediction_market.py");
console.log("proof saved -> parity-proof.txt");
