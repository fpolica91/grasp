import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// node-pty (and its per-platform native packages) must NOT be bundled — they load a
// native addon via a dynamic require at runtime. externalizeDepsPlugin keeps every
// node_modules dependency external in the main/preload builds; we also name the pty
// platform packages explicitly since they are optional/indirect deps.
const nativeExternals = [
  '@lydell/node-pty',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-linux-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-win32-x64'
]

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: nativeExternals
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
