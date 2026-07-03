// Encrypted credential vault. The model key is stored via Electron safeStorage —
// backed by the OS keychain (macOS Keychain, libsecret, Windows DPAPI). This is
// deliberately BETTER than ZCode's approach: they ship provider keys in plaintext in
// config.json (6 occurrences, incl. a hardcoded shared key) despite having a crypto
// module, and their fallback key is a deterministic machine-bound value. We never write
// the key in the clear and never ship one.
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const vaultFile = (): string => join(app.getPath('userData'), 'grasp-key.bin')
let cached: string | null = null

export function getKey(): string {
  if (cached !== null) return cached
  // env override is honored (dev/CI) but never persisted.
  if (process.env.GRASP_API_KEY) return (cached = process.env.GRASP_API_KEY)
  try {
    const f = vaultFile()
    if (existsSync(f) && safeStorage.isEncryptionAvailable()) {
      cached = safeStorage.decryptString(readFileSync(f))
      return cached
    }
  } catch {
    /* corrupt/unreadable vault -> treat as unset */
  }
  return ''
}

export function setKey(key: string): { ok: boolean; error?: string; warning?: string } {
  const k = key.trim()
  if (!k) return { ok: false, error: 'empty key' }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // No OS keychain (e.g. a headless box). We never write the key in the clear — hold
      // it in memory for this session only. Usable now; re-enter next launch.
      cached = k
      return { ok: true, warning: 'OS keychain unavailable — key kept in memory this session only (not saved to disk).' }
    }
    writeFileSync(vaultFile(), safeStorage.encryptString(k), { mode: 0o600 })
    cached = k
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function hasKey(): boolean {
  return getKey().length > 0
}
