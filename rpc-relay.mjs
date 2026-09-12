// rpc-relay.mjs — universal browser QUIC relay for the Bradbury RPC.
//
// The direct TCP path to rpc-bradbury.genlayer.com is broken by DPI:
//   * requests over ~1KB get RST mid-upload,
//   * responses over ~1KB stall mid-download.
// Browsers negotiate HTTP/3 (QUIC over UDP) to Cloudflare, which is not
// affected. This server:
//   1. serves rpc-relay.html locally,
//   2. exposes a job queue: the browser polls /next, executes the RPC
//      request over QUIC, and posts the result back to /result,
//   3. exports installFetchRelay() which monkey-patches globalThis.fetch so
//      any Node script (genlayer-js uses plain fetch, see
//      node_modules/genlayer-js/dist/index.js line ~2396) transparently
//      tunnels through the browser.
//
// Usage:
//   node rpc-relay.mjs            # start relay + open browser tab
//   node rpc-relay.mjs --check    # start relay, run a self-test, exit
import http from "node:http";
import { readFileSync } from "node:fs";
import { exec } from "node:child_process";

const PORT = Number(process.env.PORT || 8898);
const html = readFileSync(new URL("./rpc-relay.html", import.meta.url), "utf8");

// ---- job queue -------------------------------------------------------------
let nextId = 1;
const queue = [];
const waiting = new Map(); // id -> {resolve, reject, timer}
const pollers = []; // resolves of pending /next long-polls

function notifyPollers() {
  while (pollers.length) {
    const w = pollers.shift();
    try { w(); } catch { /* ignore */ }
  }
}

function removePoller(w) {
  const i = pollers.indexOf(w);
  if (i !== -1) pollers.splice(i, 1);
}

function enqueue(bodyText) {
  const id = nextId++;
  notifyPollers();
  return new Promise((resolve, reject) => {
    queue.push({ id, body: bodyText });
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error("relay: job " + id + " timed out after 120s"));
    }, 120000);
    waiting.set(id, { resolve, reject, timer });
  });
}

function resolveJob(id, payload) {
  const w = waiting.get(id);
  if (!w) return false;
  clearTimeout(w.timer);
  waiting.delete(id);
  if (payload && payload.ok) w.resolve(payload);
  else w.reject(new Error("relay: browser fetch failed (job " + id + ")"));
  return true;
}

// ---- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // Unref every accepted connection: browser tabs keep long-poll
  // connections open indefinitely, and refed sockets would keep the Node
  // process alive after the importing script has finished its work.
  if (res.socket && typeof res.socket.unref === "function") res.socket.unref();
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && req.url === "/next") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    if (queue.length) { res.end(JSON.stringify(queue.shift())); return; }
    // Long-poll: hold the request open until a job arrives (or ~50s).
    // Background-tab timer throttling then cannot starve the queue: the
    // pending fetch is not throttled, only the re-poll timer is.
    let wake = null;
    const wakePromise = new Promise((resolve) => { wake = resolve; });
    const timer = setTimeout(() => { removePoller(wake); wake(); }, 50000);
    // Unref: the re-poll timer of an idle browser tab must not keep the
    // Node process alive after the importing script has finished its work.
    timer.unref();
    pollers.push(wake);
    req.on("close", () => { clearTimeout(timer); removePoller(wake); });
    await wakePromise;
    res.end(queue.length ? JSON.stringify(queue.shift()) : "{}");
    return;
  }
  if (req.method === "POST" && req.url === "/result") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(raw);
        const known = resolveJob(j.id, j);
        console.log("[relay] job " + j.id + " " + (j.ok ? "ok (" + (j.text || "").length + "B)" : "FAILED") + (known ? "" : " (unknown/stale)"));
      } catch (e) {
        console.log("[relay] bad result payload");
      }
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("ok");
    });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("rpc relay on http://127.0.0.1:" + PORT + "/");
  console.log("opening browser tab (keep it open)...");
  const child = exec('termux-open-url http://127.0.0.1:' + PORT + '/');
  // Unref so a lingering child handle cannot keep the process alive.
  child.unref();
});
// Allow importing scripts (deploy-relay/register/update) to exit cleanly
// once their work is done; the relay keeps serving in the background while
// the event loop has other pending work.
server.unref();

// ---- fetch patch -----------------------------------------------------------
const RELAY_URL = "http://127.0.0.1:" + PORT;
const RPC_HOSTS = new Set(["rpc-bradbury.genlayer.com"]);

export function installFetchRelay() {
  const orig = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    let url = "";
    try {
      url = typeof input === "string" ? input : input && input.url ? input.url : "";
    } catch { url = ""; }
    let host = "";
    try { host = new URL(url).host; } catch { host = ""; }
    if (!RPC_HOSTS.has(host)) return orig.call(this, input, init);
    const body = typeof init?.body === "string" ? init.body : "";
    if (!body) return orig.call(this, input, init);
    const payload = await enqueue(body);
    return new Response(payload.text, {
      status: payload.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  console.log("[relay] globalThis.fetch patched — RPC calls now tunnel through the browser");
}

// Self-test mode: verify the relay end-to-end with a small request.
if (process.argv.includes("--check")) {
  await new Promise((r) => setTimeout(r, 4000)); // let the browser tab spin up
  installFetchRelay();
  const r = await fetch("https://rpc-bradbury.genlayer.com/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const t = await r.text();
  console.log("SELF-TEST:", t.slice(0, 120));
  process.exit(t.includes("result") ? 0 : 1);
}
