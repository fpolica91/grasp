// Preload for the grasp graph window (used by BOTH the standalone app and the
// ZCode graft). Exposes a minimal, isolated bridge — no node in the renderer.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grasp", {
  // run a flow skill; resolves { ok, html, err }
  run: (params) => ipcRenderer.invoke("grasp:run", params),
  // terminal (standalone only; a no-op if the host has no term handler)
  termInput: (line) => ipcRenderer.send("term:input", line),
  onTermData: (cb) => ipcRenderer.on("term:data", (_e, data) => cb(data)),
});
