// grasp-flow — inject the observed-dataflow SURFACE into the ZCode fork's renderer.
// This is the differentiator made physical: the post-editor surface where you'd
// otherwise read a diff. Prepended to out/main/index.js (after the egress guard +
// auth strip). Touches none of ZCode's minified React.
//
// Two parts:
//   1. a loopback HTTP server that runs the grasp engine and serves the graph HTML
//      (loopback is allowed by the egress guard; the engine does the real execution).
//   2. a content-script injected into the renderer that docks a "◈ Flow" panel — a
//      <webview> pointed at that server (webview bypasses the renderer CSP).
//
// Engine via env: GRASP_ENGINE=/path/to/grasp/engine (with .venv), or GRASP_PY.
import { app } from "electron";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const ENGINE = process.env.GRASP_ENGINE || "";
const PY = process.env.GRASP_PY || (ENGINE ? path.join(ENGINE, ".venv", "bin", "python") : "python3");
const PORT = Number(process.env.GRASP_FLOW_PORT || 7373);

function runEngine(p) {
  return new Promise((resolve) => {
    if (!ENGINE) return resolve(errPage("set GRASP_ENGINE to the grasp/engine dir (with make venv)"));
    const a = [p.cap || "observe", "--repo", p.repo || ".", "--entrypoint", p.entrypoint || "", "--html"];
    if (p.input) a.push("--input", p.input);
    if (p.cap === "diff" && p.old) a.push("--old", p.old);
    const cp = spawn(PY, ["-m", "dreplay.skill", ...a], { cwd: ENGINE });
    let out = "", err = "";
    cp.stdout.on("data", (d) => (out += d));
    cp.stderr.on("data", (d) => (err += d));
    cp.on("error", (e) => resolve(errPage(e.message)));
    cp.on("close", () => resolve(out.startsWith("<!doctype") ? out : errPage(err || "no output")));
  });
}

function errPage(msg) {
  return "<!doctype html><meta charset=utf-8><body style='background:#0f1216;color:#e0a852;"
    + "font:13px ui-monospace,monospace;padding:20px;line-height:1.6'>grasp engine: "
    + String(msg).replace(/[<>&]/g, "") + "</body>";
}

const PANEL = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{--g:#0f1216;--s:#171b21;--ink:#e6e9ee;--muted:#8b95a5;--hair:#262c34;--accent:#5b9bff;--mono:ui-monospace,"SF Mono",Menlo,monospace;--sans:system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--g);color:var(--ink);font-family:var(--sans);display:flex;flex-direction:column}
header{padding:11px 14px;border-bottom:1px solid var(--hair);flex:none}
.brand{font-weight:600}.tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-left:8px}
.bar{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;border-bottom:1px solid var(--hair);flex:none}
.bar input{font-family:var(--mono);font-size:12px;background:#131217;color:var(--ink);border:1px solid var(--hair);border-radius:6px;padding:6px 8px}
#ep{flex:1;min-width:150px}#in{width:120px}#old{width:74px}
button{font-family:var(--sans);font-size:12px;cursor:pointer;background:#132139;color:var(--accent);border:1px solid var(--accent);border-radius:6px;padding:6px 11px}
button.ghost{background:transparent;color:var(--muted);border-color:var(--hair)}
iframe{flex:1;border:0;width:100%;background:var(--g)}
</style></head><body>
<header><span class="brand">grasp</span><span class="tag">observed dataflow · not a diff</span></header>
<div class="bar">
<input id="repo" value="." title="repo"><input id="ep" placeholder="module.func">
<input id="in" placeholder='{"name":"x"}'><button id="obs">Observe</button>
<input id="old" placeholder="HEAD~1"><button id="dif" class="ghost">A→B</button>
</div>
<iframe id="g"></iframe>
<script>
var $=function(i){return document.getElementById(i)};
function run(cap){var q=new URLSearchParams({cap:cap,repo:$("repo").value,entrypoint:$("ep").value,input:$("in").value});if(cap==="diff")q.set("old",$("old").value||"HEAD~1");$("g").src="/render?"+q.toString();}
$("obs").onclick=function(){run("observe")};$("dif").onclick=function(){run("diff")};
// example on open so the surface shows a real observed flow immediately
$("ep").value="flow_canaries.scenarios.create_organization";$("in").value='{"name":"Acme"}';run("observe");
</script></body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/render") {
    const html = await runEngine(Object.fromEntries(u.searchParams));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(html);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PANEL);
}).listen(PORT, "127.0.0.1");

// content-script: dock a "◈ Flow" panel (a webview → the loopback surface).
const INJECT = `(function(){
  if(window.__graspFlow)return; window.__graspFlow=true;
  var URL_="http://127.0.0.1:${PORT}/";
  var btn=document.createElement('button');
  btn.textContent='\\u25C8 Flow';
  btn.style.cssText='position:fixed;right:18px;bottom:18px;z-index:2147483647;background:#132139;color:#5b9bff;border:1px solid #5b9bff;border-radius:20px;padding:9px 16px;font:600 13px system-ui;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  var panel=document.createElement('div');
  panel.style.cssText='position:fixed;top:0;right:0;width:560px;max-width:60vw;height:100%;z-index:2147483646;display:block;box-shadow:-8px 0 30px rgba(0,0,0,.5);border-left:1px solid #262c34;background:#0f1216';
  var wv=document.createElement('webview');
  wv.setAttribute('src',URL_);
  wv.style.cssText='width:100%;height:100%;border:0';
  panel.appendChild(wv);
  btn.onclick=function(){panel.style.display=(panel.style.display==='none')?'block':'none';};
  document.body.appendChild(btn); document.body.appendChild(panel);
})();`;

app.on("browser-window-created", (_e, win) => {
  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript(INJECT).catch(() => {});
  });
});
