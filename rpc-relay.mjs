// rpc-relay.mjs — universal browser QUIC relay for the Bradbury RPC.
//
// The direct TCP path to rpc-bradbury.genlayer.com is broken by DPI:
//   * requests over ~1KB get RST mid-upload,
//   * responses over ~1KB stall mid-download.
// Browsers negotiate HTTP/3 (QUIC over UDP) to Cloudflare, which is not
// affected. This server:
//   1. serves rpc-relay.html locally,
//   2. exposes a job queue: the browser polls /next, executes the RPC
//      request over QUIC, and posts the result back to /result; scripts
//      submit jobs via POST /submit (works across processes, so a script
//      reuses a standalone background relay that owns the port),
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
  console.log("[relay] " + req.method + " " + req.url + " from " + (req.socket.remoteAddress || "?"));
  // Normalize: compare the path only, so "/next?v=2" still matches /next.
  const path = (req.url || "").split("?")[0];
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && path === "/next") {
    // Version gate: only tabs running the fetchT html (v=2) may take jobs.
    // Legacy tabs (no timeout on their RPC fetch) would hang a job forever.
    const q = new URL(req.url, "http://x").searchParams;
    if (q.get("v") !== "2") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    if (queue.length) { res.end(JSON.stringify(queue.shift())); return; }
    // Track liveness: a pending (or fresh) v=2 long-poll means a healthy
    // tab is connected; the self-healer above uses this timestamp.
    lastV2Poll = Date.now();
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
  if (req.method === "POST" && path === "/result") {
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
  if (req.method === "POST" && path === "/diag") {
    // Boot diagnostics from the relay tab (connectivity trace, RPC probe).
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const j = JSON.parse(raw);
        for (const k of Object.keys(j)) console.log("[relay-tab " + k + "] " + String(j[k]));
      } catch { /* ignore */ }
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("ok");
    });
    return;
  }
  if (req.method === "POST" && path === "/submit") {
    // Used by importing scripts whose own listen attempt hit EADDRINUSE:
    // the job is forwarded over HTTP to whichever process owns the port
    // (usually a standalone background relay), and the HTTP response
    // carries the browser's result back to the caller.
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      enqueue(raw).then(
        (payload) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: payload.status, text: payload.text }));
        },
        (e) => {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        },
      );
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

server.on("error", (err) => {
  // EADDRINUSE: another relay instance already listens on this port
  // (e.g. a standalone background relay). Reuse it instead of crashing —
  // the fetch patch below works against whichever instance owns the port.
  if (err && err.code === "EADDRINUSE") {
    console.log("[relay] port " + PORT + " already in use — reusing the running relay");
    return;
  }
  throw err;
});
// Bind all interfaces, not just loopback: a VPN/proxy extension that
// 403-blocks page loads from 127.0.0.1/localhost often still allows
// private LAN IPs, so the tab can also be opened as http://<lan-ip>:8898/.
import os from "node:os";
function lanIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}
const LAN = lanIp();
let lastV2Poll = Date.now();
server.listen(PORT, "0.0.0.0", () => {
  const url = "http://" + LAN + ":" + PORT + "/";
  console.log("rpc relay on " + url + " (tab URL; 127.0.0.1 may be 403-blocked by a VPN proxy extension)");
  const openTab = () => exec('start "" "' + url + '"');
  console.log("opening browser tab (keep it open)...");
  openTab();
  // Self-healing: if no v=2 tab has polled for 90s, open the tab again
  // (Chrome may discard background tabs or the window may get closed).
  setInterval(() => {
    if (Date.now() - lastV2Poll > 90000) {
      console.log("[relay] no v2 tab poll for 90s — reopening the tab");
      openTab();
      lastV2Poll = Date.now(); // give the new tab a full window before respamming
    }
  }, 30000).unref();
});
// Allow importing scripts (deploy-relay/register/update) to exit cleanly
// once their work is done. When run STANDALONE (node rpc-relay.mjs), the
// server must stay refed — otherwise the process exits immediately.
import { pathToFileURL } from "node:url";
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) server.unref();

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
    // Route the job through whichever relay process owns the port: usually
    // a standalone background relay, possibly this process's own server.
    // A plain in-process enqueue only works when THIS process is the one
    // the browser tab polls — not the case when a background relay
    // already owns the port (EADDRINUSE).
    let payload;
    try {
      const r = await orig.call(this, RELAY_URL + "/submit", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body,
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error("relay /submit HTTP " + r.status + ": " + t.slice(0, 200));
      }
      payload = await r.json();
    } catch (e) {
      throw new Error("relay: /submit failed (" + ((e && e.message) || String(e)) + "); is the relay running on " + RELAY_URL + "?");
    }
    if (!payload || !payload.ok) {
      throw new Error("relay: browser fetch failed (" + ((payload && payload.error) || "no result") + ")");
    }
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
