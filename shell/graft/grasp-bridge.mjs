// grasp graft — adds the dataflow-graph window to ZCode's shell and wires it to the
// grasp engine. Prepended to out/main/index.js (after the egress guard). Touches NONE
// of ZCode's minified bundles: ZCode's own window (terminal · browser · chat) loads
// exactly as before; grasp opens ITS OWN window beside it, fully under our control
// (our preload, our IPC, no CSP fight).
//
// The engine is located via env — set when launching the grafted shell:
//   GRASP_ENGINE=/path/to/grasp/engine   (the repo's engine dir; must have .venv)
//   GRASP_PY=/path/to/python             (optional; defaults to $GRASP_ENGINE/.venv/bin/python)
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // out/main/
const ENGINE = process.env.GRASP_ENGINE || "";
const PY = process.env.GRASP_PY
  || (ENGINE ? path.join(ENGINE, ".venv", "bin", "python") : "python3");

// One IPC handler: run a flow skill, return the rendered graph HTML.
if (!ipcMain.__graspWired) {
  ipcMain.__graspWired = true;
  ipcMain.handle("grasp:run", (_evt, p) => new Promise((resolve) => {
    if (!ENGINE || !fs.existsSync(PY)) {
      return resolve({ ok: false, html: null,
        err: `grasp engine not found. Launch with GRASP_ENGINE=/path/to/grasp/engine `
           + `(and run 'make venv' there first). Looked for python at: ${PY}` });
    }
    const a = [p.cap, "--repo", p.repo, "--entrypoint", p.entrypoint, "--html"];
    if (p.input) a.push("--input", p.input);
    if (p.cap === "diff" && p.old) a.push("--old", p.old);
    const cp = spawn(PY, ["-m", "dreplay.skill", ...a], { cwd: ENGINE });
    let out = "", err = "";
    cp.stdout.on("data", (d) => (out += d));
    cp.stderr.on("data", (d) => (err += d));
    cp.on("error", (e) => resolve({ ok: false, html: null, err: e.message }));
    cp.on("close", () => resolve({ ok: out.startsWith("<!doctype"), html: out || null, err }));
  }));
}

// Open the grasp graph window once the app is ready (alongside ZCode's own).
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1080, height: 820,
    backgroundColor: "#0f1216",
    title: "grasp — dataflow",
    webPreferences: {
      preload: path.join(HERE, "grasp", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(HERE, "grasp", "renderer", "index.html"),
               { query: { mode: "graph" } });
}).catch(() => { /* not the main process, or app unavailable — no-op */ });
