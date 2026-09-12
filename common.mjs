// common.mjs — shared helpers for the prediction-market client scripts.
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// because the direct TCP path to the Bradbury RPC is broken by DPI on this
// network. Pass --direct to any script to use the plain network path.
import { readFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { installFetchRelay } from "./rpc-relay.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isTransient(e) {
  let m = "";
  try { m = (e && (e.shortMessage || e.message || "")) + " " + (e && e.details || "") + " " + ((e && e.cause && e.cause.code) || "") + " " + ((e && e.cause && e.cause.message) || ""); }
  catch (x) { m = String(e); }
  return ["fetch failed", "ECONNABORTED", "ECONNRESET", "capacity", "-32005", "timeout", "socket", "terminated", "relay:", "HTTP request failed", "consensus contract", "EVM tx", "-32001", "contract not found", "ResourceNotFound", "resource not found"].some(s => m.indexOf(s) >= 0);
}

export async function robust(label, fn, tries) {
  const T = tries || 30;
  for (let i = 1; i <= T; i++) {
    try { return await fn(); }
    catch (e) {
      if (isTransient(e) && i < T) { console.log(label + " transient, retry " + i + " of " + T); await sleep(3000); continue; }
      throw e;
    }
  }
}

export function makeClient(privateKey) {
  const account = createAccount(privateKey);
  const client = createClient({ chain: testnetBradbury, account });
  return { account, client };
}

export async function setup(opts = {}) {
  const needAddress = opts.needAddress !== false;
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  if (!PRIVATE_KEY) { throw new Error("PRIVATE_KEY missing. Use: node --env-file=.env <script>.mjs"); }
  if (!process.argv.includes("--direct")) {
    installFetchRelay();
    console.log("waiting 8s for the browser relay tab...");
    await sleep(8000);
  }
  const { account, client } = makeClient(PRIVATE_KEY);
  let address = (process.env.CONTRACT_ADDRESS || "").trim();
  if (!address) {
    try { address = String(readFileSync("contract.txt", "utf8")).trim(); } catch { address = ""; }
  }
  if (!address && needAddress) {
    throw new Error("contract address missing: run deploy.mjs first (it writes contract.txt and CONTRACT_ADDRESS)");
  }
  if (address) console.log("contract:", address);
  return { account, client, address, accountAddress: account.address };
}

export async function result(client, hash) {
  await robust("receipt wait", () => client.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 400 }));
  const tx = await robust("tx read", () => client.getTransaction({ hash }));
  return tx;
}

// Submit + wait for a write call; returns the execution result name
// ("FINISHED_WITH_RETURN" / "FINISHED_WITH_ERROR" / ...), never throws on
// contract-level reverts (UserError) — those are expected in gating tests.
export async function callTx(client, address, fn, args, value) {
  const hash = await robust(fn + " submit", () =>
    client.writeContract({ address, functionName: fn, args, value: value || 0n }));
  const tx = await result(client, hash);
  const r = tx?.txExecutionResultName;
  console.log("  " + fn + " -> " + r + " (tx " + hash + ")");
  return { hash, result: r, tx };
}

export function clean(tx) {
  const r = tx?.txExecutionResultName ?? tx;
  return r === "FINISHED" || r === "FINISHED_WITH_RETURN";
}

export function parseJson(s) {
  try { return JSON.parse(String(s)); } catch { return null; }
}
