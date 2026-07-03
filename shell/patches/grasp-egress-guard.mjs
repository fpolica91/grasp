/**
 * grasp egress guard — deny-by-default network wall for the (forked) ZCode shell.
 *
 * WHY: the upstream shell phones home on several channels we did not choose —
 * Alibaba SLS telemetry (proj-xtrace-*.log.aliyuncs.com), a RUM collector, a
 * Telegram-bot integration, a hardcoded dev box (192.168.6.166:8080), and an
 * auto-updater CDN. A "full understanding, minimal guessing" tool must not narrate
 * its users to someone else's dashboard.
 *
 * STANCE (dreplay's own philosophy, applied to the shell): deny by construction,
 * not by asking. We do NOT trust that we surgically excised every call from the
 * minified bundles — we physically deny egress to everything except an explicit
 * allowlist, and we log every block.
 *
 * HONEST SCOPE — this seals the two layers a JS app actually egresses through:
 *   1. Node-layer: globalThis.fetch (undici) + node:http / node:https. This is the
 *      layer the telemetry/Telegram/provider calls in main+host use, and the layer
 *      Electron's session.webRequest CANNOT see. Sealed synchronously at load.
 *   2. Chromium-layer: session.webRequest on every session (renderer + net module),
 *      best-effort, main process only.
 * RESIDUAL (named, not hidden): a native addon or a spawned child process making its
 * own syscalls bypasses a JS monkeypatch — same residual dreplay names for its
 * python_layer wall. For a hard guarantee add an OS-level rule (firewall / netns).
 * This module must be imported FIRST in BOTH out/main/index.js and out/host/index.js.
 *
 * ALLOWLIST: GRASP_ALLOW_HOSTS = comma-separated host suffixes you explicitly permit
 * (e.g. "api.z.ai,api.anthropic.com"). Loopback is always allowed (the app's own
 * main<->host<->renderer RPC). Everything else is denied.
 */

const ALLOW = (process.env.GRASP_ALLOW_HOSTS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", ""]);

export function hostAllowed(rawHost) {
  if (rawHost == null) return false;
  const host = String(rawHost).toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (LOOPBACK.has(host)) return true;
  return ALLOW.some((a) => host === a || host.endsWith("." + a));
}

function denyError(host, via) {
  process.stderr.write(`[grasp-egress] BLOCKED ${via} -> ${host || "?"}\n`);
  return new Error(
    `[grasp-egress] egress to ${host || "?"} denied (deny-by-default). ` +
    `Add it to GRASP_ALLOW_HOSTS to permit.`
  );
}

function urlHost(u) {
  try { return new URL(String(u)).hostname; } catch { return null; }
}

// ---- 1a) globalThis.fetch (undici) ----------------------------------------- //
if (typeof globalThis.fetch === "function") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const host = urlHost(typeof input === "string" ? input : input && input.url);
    if (host !== null && !hostAllowed(host)) return Promise.reject(denyError(host, "fetch"));
    return realFetch.call(this, input, init);
  };
}

// ---- 1b) node:http / node:https request+get -------------------------------- //
async function patchNodeHttp() {
  for (const name of ["node:http", "node:https"]) {
    let mod;
    try { mod = await import(name); } catch { continue; }
    const m = mod.default || mod;
    for (const fn of ["request", "get"]) {
      const real = m[fn];
      if (typeof real !== "function") continue;
      m[fn] = function (...args) {
        let host = null;
        const a0 = args[0];
        if (typeof a0 === "string" || a0 instanceof URL) host = urlHost(a0);
        else if (a0 && typeof a0 === "object") host = a0.hostname || a0.host || null;
        if (host !== null && !hostAllowed(host)) throw denyError(host, name.replace("node:", ""));
        return real.apply(this, args);
      };
    }
  }
}
patchNodeHttp();

// ---- 2) Electron session webRequest (Chromium-layer, main process only) ---- //
import("electron").then((e) => {
  const app = e.app, session = e.session;
  if (!app || !session) return;
  const install = (sess) => {
    try {
      sess.webRequest.onBeforeRequest((details, cb) => {
        const host = urlHost(details.url);
        if (host !== null && !hostAllowed(host)) {
          process.stderr.write(`[grasp-egress] BLOCKED session -> ${host}\n`);
          return cb({ cancel: true });
        }
        cb({ cancel: false });
      });
    } catch { /* older Electron / no webRequest on this session */ }
  };
  const boot = () => { try { install(session.defaultSession); } catch {} };
  if (typeof app.isReady === "function" && app.isReady()) boot();
  else if (typeof app.whenReady === "function") app.whenReady().then(boot).catch(() => {});
  if (typeof app.on === "function") app.on("session-created", install);
}).catch(() => { /* not the main process (host/worker) — Node layer already sealed */ });
