// File-driven keybindings. ~/.grasp/keybindings.json maps an action id to a chord string
// (e.g. { "new-session": "mod+shift+n" }), merged over the defaults. Chord grammar:
//   mod+<key>          (mod = Cmd on mac, Ctrl elsewhere — cross-platform)
//   ctrl+<key> | cmd+<key> | shift+<key> | alt+<key>   (combinable: "mod+shift+p")
// A missing or malformed file leaves the defaults in place.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The bindable actions. Keep these stable ids — the renderer dispatches on them.
export const DEFAULT_KEYBINDINGS: Record<string, string> = {
  'new-session': 'mod+n',
  'command-palette': 'mod+k',
  'toggle-terminal': 'ctrl+`',
  'toggle-sidebar': 'mod+b',
  'toggle-side-pane': 'mod+l',
  'editor-persona': 'mod+g'
}

export function loadKeybindings(): Record<string, string> {
  const kb: Record<string, string> = { ...DEFAULT_KEYBINDINGS }
  const p = join(homedir(), '.grasp', 'keybindings.json')
  if (!existsSync(p)) return kb
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        if (typeof k === 'string' && typeof v === 'string' && v.trim()) kb[k] = v.toLowerCase()
      }
    }
  } catch {
    /* malformed -> keep defaults */
  }
  return kb
}
