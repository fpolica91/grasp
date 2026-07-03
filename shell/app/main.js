// grasp desktop — the post-editor shell (our own Electron app, recreated from the
// ZCode reverse-engineering; no proprietary bundle). Three panes: the dataflow GRAPH
// (the star — replaces the editor), a TERMINAL, and a BROWSER. The graph is driven by
// the engine: the renderer asks main to run a flow skill, main shells the engine's
// python and returns the rendered graph HTML.
//
// No telemetry exists here by construction — we wrote it, there is nothing phoning
// home to strip. (The deny-by-default guard in ../patches is for the OTHER path,
// running ZCode's proprietary binary; a from-scratch recreation doesn't need it, and
// it would break the browser pane.)
"use strict";

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// Where the engine lives + which python runs it. Overridable via env.
const ENGINE = process.env.GRASP_ENGINE || path.resolve(__dirname, "..", "..", "engine");
const PY = process.env.GRASP_PY || path.join(ENGINE, ".venv", "bin", "python");

// ---- the graph pane: run a flow skill, return rendered graph HTML --------------- //
ipcMain.handle("grasp:run", (_evt, p) => {
  return new Promise((resolve) => {
    if (!fs.existsSync(PY)) {
      return resolve({ ok: false, html: null,
        err: `engine python not found at ${PY}. Run: cd ${ENGINE} && make venv` });
    }
    const args = [p.cap, "--repo", p.repo, "--entrypoint", p.entrypoint, "--html"];
    if (p.input) args.push("--input", p.input);
    if (p.cap === "diff" && p.old) args.push("--old", p.old);
    const cp = spawn(PY, ["-m", "dreplay.skill", ...args], { cwd: ENGINE });
    let out = "", err = "";
    cp.stdout.on("data", (d) => (out += d));
    cp.stderr.on("data", (d) => (err += d));
    cp.on("error", (e) => resolve({ ok: false, html: null, err: `cannot launch engine: ${e.message}` }));
    cp.on("close", () => resolve({ ok: out.startsWith("<!doctype"), html: out || null, err }));
  });
});

// ---- the terminal pane: one persistent shell, streamed to the renderer ---------- //
const shells = new Map(); // webContents.id -> child process

function ensureShell(win) {
  const id = win.webContents.id;
  if (shells.has(id)) return shells.get(id);
  const shellPath = process.platform === "win32"
    ? "powershell.exe"
    : (process.env.SHELL || "/bin/bash");
  const sh = spawn(shellPath, [], { cwd: process.env.HOME || process.cwd(), env: process.env });
  const send = (data) => { if (!win.isDestroyed()) win.webContents.send("term:data", data.toString()); };
  sh.stdout.on("data", send);
  sh.stderr.on("data", send);
  sh.on("close", () => { shells.delete(id); send("\n[shell exited]\n"); });
  sh.on("error", (e) => send(`\n[shell error: ${e.message}]\n`));
  shells.set(id, sh);
  return sh;
}

ipcMain.on("term:input", (evt, line) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return;
  try { ensureShell(win).stdin.write(line + "\n"); } catch (_e) { /* shell gone */ }
});

// ---- window --------------------------------------------------------------------- //
function createWindow() {
  const win = new BrowserWindow({
    width: 1240, height: 880,
    backgroundColor: "#0f1216",
    title: "grasp — the post-editor",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,        // the browser pane
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // preload uses require(); renderer stays isolated
    },
  });
  const query = { mode: "full" };
  if (process.env.GRASP_DEMO) query.demo = process.env.GRASP_DEMO; // seed a first observe
  win.loadFile(path.join(__dirname, "renderer", "index.html"), { query });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const sh of shells.values()) { try { sh.kill(); } catch (_e) {} }
  if (process.platform !== "darwin") app.quit();
});
