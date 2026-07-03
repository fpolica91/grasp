# grasp shell — the desktop app

Two ways to run the post-editor. Both drive the same engine and render the same
dataflow graph (`shell/app/renderer/` is shared).

## A. Standalone app (fastest — verified booting)

Our own thin Electron shell: the dataflow **graph** (the star) + a **terminal** + a
**browser**. One dependency (Electron).

```bash
cd engine && make venv          # the engine the app calls (once)
cd ../shell/app && npm install  # electron
npm start                       # opens the window
```

In the window: set **repo** + **entrypoint** (e.g. `flow_canaries.scenarios.create_organization`,
input `{"name":"Acme"}`), press **Observe** — grasp runs it for real and shows the observed
dataflow, ending in a question. **Diff A→B** observes an old git ref vs the working tree.

`graph/examples/grasp-desktop.png` is a real screenshot of this running.

## B. Graft into ZCode's shell (reuse the full chassis)

Adds the grasp graph window to ZCode's real shell (its terminal · browser · chat run
untouched) without editing any of its minified bundles — a prepend + our own window.

```bash
# 1. extract ZCode's app.asar to a tree (see TELEMETRY-STRIP.md), then:
./patches/apply.sh <extracted-app> <resources-dir>   # deny-by-default telemetry guard
./graft/graft.sh   <extracted-app>                   # add the grasp graph window
npx @electron/asar pack <extracted-app> app.asar     # repack

# 2. launch (point at the engine dir; allow only your model provider)
GRASP_ENGINE=/path/to/grasp/engine GRASP_ALLOW_HOSTS=api.z.ai <zcode-electron-binary> .
```

`grasp-bridge.mjs` is prepended to `out/main/index.js` (below the egress guard); it opens
the grasp window with our preload + a `grasp:run` IPC handler that shells the engine.

## Notes

- The app calls the engine via `python -m dreplay.skill <observe|diff> --html`. Override the
  engine location with `GRASP_ENGINE` / `GRASP_PY`.
- Headless verification (this repo was built on a headless host): boot under a virtual
  display with `xvfb-run ./node_modules/electron/dist/electron . --no-sandbox`.
- No telemetry exists in the standalone app by construction. The egress guard matters only
  for path B (running ZCode's proprietary binary).
