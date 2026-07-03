/**
 * Headless verification of the egress guard's Node-layer deny — runs under plain
 * `node`, no Electron, no display. Proves the guarantee we CAN prove here: the
 * telemetry / Telegram / dev-box hosts are denied, the explicit allowlist + loopback
 * pass, and globalThis.fetch actually rejects a blocked host before any socket opens.
 *
 *   GRASP_ALLOW_HOSTS=api.z.ai node grasp-egress-guard.test.mjs
 */
process.env.GRASP_ALLOW_HOSTS = process.env.GRASP_ALLOW_HOSTS || "api.z.ai,api.anthropic.com";
const { hostAllowed } = await import("./grasp-egress-guard.mjs");

let fails = 0;
function check(label, cond) {
  if (cond) { console.log(`  ok   ${label}`); }
  else { console.error(`  FAIL ${label}`); fails++; }
}

// --- denied: every phone-home channel we found in the shell ---
check("deny Alibaba SLS telemetry",
  hostAllowed("proj-xtrace-abc.cn-beijing.log.aliyuncs.com") === false);
check("deny Telegram bot", hostAllowed("api.telegram.org") === false);
check("deny hardcoded dev box", hostAllowed("192.168.6.166") === false);
check("deny updater CDN", hostAllowed("cdn-zcode.z.ai") === false);
check("deny Lark/Feishu", hostAllowed("open.feishu.cn") === false);
check("deny WeChat", hostAllowed("ilinkai.weixin.qq.com") === false);

// --- allowed: explicit allowlist + subdomains + loopback (the app's own RPC) ---
check("allow explicit provider", hostAllowed("api.z.ai") === true);
check("allow allowlisted subdomain", hostAllowed("open.api.z.ai") === true);
check("allow anthropic", hostAllowed("api.anthropic.com") === true);
check("allow loopback 127.0.0.1", hostAllowed("127.0.0.1") === true);
check("allow localhost", hostAllowed("localhost") === true);
// suffix must be dot-anchored: 'notapi.z.ai.evil.com' must NOT match 'api.z.ai'
check("no unanchored suffix bypass", hostAllowed("api.z.ai.evil.com") === false);

// --- the actual fetch wrapper rejects a denied host before opening a socket ---
let rejected = false;
try { await globalThis.fetch("https://proj-xtrace-x.cn-beijing.log.aliyuncs.com/put"); }
catch (e) { rejected = /denied/.test(String(e.message)); }
check("fetch() rejects denied host", rejected === true);

console.log(fails === 0 ? "\nPASS — egress guard denies by default" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
