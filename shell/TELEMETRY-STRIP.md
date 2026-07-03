# ZCode shell — telemetry rip-out

grasp reuses ZCode 3.2.5's Electron/React shell as its chassis (terminal · webview ·
chat, agent-first, diff-pane to be swapped for the dataflow graph). This documents
what phones home in the upstream build and how grasp neutralizes it — **honestly**:
what is verified vs. what is residual.

## The egress surface (every external host found in `out/{main,host,preload}`)

| Host | What it is | Verdict |
|---|---|---|
| `proj-xtrace-*.cn-beijing.log.aliyuncs.com` | Alibaba SLS log sink (xtrace telemetry) | **rip out** — telemetry, `main/chunk-7ZQLCZIZ.js` |
| RUM collector (`@arms/rum-*`) | Alibaba ARMS real-user-monitoring | **rip out** — telemetry, main+host+preload |
| `open.feishu.cn` · `open.larksuite.com` · `accounts.*` | Lark/Feishu SDK (`@larksuiteoapi/node-sdk`) | **rip out** — telemetry/integration |
| `api.telegram.org` | Telegram-bot integration (getMe/setMyCommands) | **deny** — egress vector, `host/index.js` |
| `192.168.6.166:8080` | a dev's LAN model server ("ZAPI") **hardcoded into the shipped build** | **deny** — build leak, main+host |
| `ilinkai.weixin.qq.com` | WeChat | **deny** |
| `cdn-zcode.z.ai` · `cdn.zcode-ai.com` · `studio.zcode-ai.com` | auto-updater / CDN | **disable + deny** |
| `zcode.chatglm.site` · `zai-test.chatglm.site` · `zcode.invalid` | test/staging endpoints left in build | **deny** |
| `www.apple.com` | captive-portal connectivity probe | deny (harmless) |
| `api.z.ai` · `open.bigmodel.cn` · `chat.z.ai` · `api.chatglm.site` | **model providers** | **allow if you choose it** (GRASP_ALLOW_HOSTS) |
| `json-schema.org` · `w3.org` | schema `$id` refs (not fetched) | n/a |

## What grasp does

1. **Deny-by-default egress guard** (`patches/grasp-egress-guard.mjs`), injected as the
   FIRST import of **both** `out/main/index.js` and `out/host/index.js`. It seals the two
   layers a JS app egresses through:
   - **Node layer** — wraps `globalThis.fetch` (undici) + `node:http`/`node:https`. This is
     the layer the telemetry/Telegram/provider calls actually use, and the layer Electron's
     `session.webRequest` **cannot** see.
   - **Chromium layer** — `session.webRequest.onBeforeRequest` on every session (renderer +
     `net` module), main process only.

   Everything is denied except loopback (the app's own main↔host↔renderer RPC) and the hosts
   you list in `GRASP_ALLOW_HOSTS`. Every block is logged (`[grasp-egress] BLOCKED …`).

2. **Defense-in-depth**: removes `node_modules/@arms` and `node_modules/@larksuiteoapi`.
3. **Auto-updater disabled**: renames `resources/app-update.yml` → `.disabled` (and its CDN
   is denied by the guard regardless).

## Verified vs. residual (no green light that lies)

- **VERIFIED, headless** (`node patches/grasp-egress-guard.test.mjs`, runs here, no display):
  every phone-home host above is denied; the explicit allowlist + loopback pass; suffix
  matching is dot-anchored (no `api.z.ai.evil.com` bypass); `fetch()` rejects a denied host
  **before a socket opens**.
- **NOT claimed**: we did **not** surgically excise every telemetry call from the minified
  esbuild bundles. We don't have to — the guard denies the egress by construction. This is a
  deliberate choice over editing minified code we couldn't verify.
- **RESIDUAL** (named, per the project's honesty rule): a native addon or a spawned child
  process making its own syscalls bypasses a JS monkeypatch — the same residual dreplay names
  for its Python-layer wall. For a hard guarantee, add an OS-level rule (firewall / `netns`).
- **BOOT not verified here**: this host is `aarch64` and headless — the full Electron GUI
  can't be launched to runtime-confirm. Do that on a desktop:
  ```
  ./patches/apply.sh <extracted-app> <resources-dir>
  npx @electron/asar pack <extracted-app> app.asar     # repack
  GRASP_ALLOW_HOSTS=api.z.ai <electron> .               # watch stderr for [grasp-egress] BLOCKED
  ```

## Reproduce

```
./patches/apply.sh /path/to/extracted/app /path/to/resources   # idempotent
node patches/grasp-egress-guard.test.mjs                        # verify the guard
```

The extracted upstream tree (`shell/zcode/`, ~247 MB, proprietary — License: unknown) is
**git-ignored**. This repo commits only grasp's own work: the guard, its test, the injector,
and this manifest.
