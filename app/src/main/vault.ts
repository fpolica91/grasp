// Encrypted credential vault, namespaced per provider (glm / openai / …). Keys are
// stored via Electron safeStorage — backed by the OS keychain (macOS Keychain,
// libsecret, Windows DPAPI). This is deliberately BETTER than ZCode's approach: they
// ship provider keys in plaintext in config.json (6 occurrences, incl. a hardcoded
// shared key) despite having a crypto module, and their fallback key is a deterministic
// machine-bound value. We never write a key in the clear and never ship one.
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// glm keeps the legacy filename so existing vaults keep working.
const vaultFile = (provider: string): string =>
  join(app.getPath('userData'), provider === 'glm' ? 'grasp-key.bin' : `grasp-key-${provider}.bin`)

// env overrides are honored (dev/CI) but never persisted.
const ENV_OVERRIDE: Record<string, string | undefined> = {
  get glm() {
    return process.env.GRASP_API_KEY
  },
  get openai() {
    return process.env.GRASP_OPENAI_KEY
  },
  get anthropic() {
    return process.env.GRASP_ANTHROPIC_KEY ?? process.env.GRASP_CLAUDE_KEY
  }
}

const cached = new Map<string, string>()

export function getKey(provider = 'glm'): string {
  const hit = cached.get(provider)
  if (hit !== undefined) return hit
  const env = ENV_OVERRIDE[provider]
  if (env) {
    cached.set(provider, env)
    return env
  }
  try {
    const f = vaultFile(provider)
    if (existsSync(f) && safeStorage.isEncryptionAvailable()) {
      const k = safeStorage.decryptString(readFileSync(f))
      cached.set(provider, k)
      return k
    }
  } catch {
    /* corrupt/unreadable vault -> treat as unset */
  }
  return ''
}

export function setKey(key: string, provider = 'glm'): { ok: boolean; error?: string; warning?: string } {
  const k = key.trim()
  if (!k) return { ok: false, error: 'empty key' }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      // No OS keychain (e.g. a headless box). We never write the key in the clear — hold
      // it in memory for this session only. Usable now; re-enter next launch.
      cached.set(provider, k)
      return { ok: true, warning: 'OS keychain unavailable — key kept in memory this session only (not saved to disk).' }
    }
    writeFileSync(vaultFile(provider), safeStorage.encryptString(k), { mode: 0o600 })
    cached.set(provider, k)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function hasKey(provider = 'glm'): boolean {
  return getKey(provider).length > 0
}
