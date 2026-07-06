// External app launcher — detect installed editors/terminals and open the workspace in one.
// Matches ZCode's app-switcher dropdown (VS Code, Cursor, Zed, Warp, Finder, etc.)
import { spawnSync } from 'node:child_process'

export interface ExternalApp {
  id: string
  name: string
  command: string
  args: string[]
  icon: string // emoji fallback
}

const APP_CANDIDATES: ExternalApp[] = [
  { id: 'vscode', name: 'VS Code', command: 'code', args: ['.'], icon: '🔵' },
  { id: 'cursor', name: 'Cursor', command: 'cursor', args: ['.'], icon: '🖱' },
  { id: 'zed', name: 'Zed', command: 'zedit', args: ['.'], icon: '⚡' },
  { id: 'neovim', name: 'Neovim', command: 'nvim', args: ['.'], icon: '📝' },
  { id: 'emacs', name: 'Emacs', command: 'emacs', args: ['.'], icon: '𝐄' },
  { id: 'sublime', name: 'Sublime', command: 'subl', args: ['.'], icon: '🅢' },
  { id: 'datagrip', name: 'DataGrip', command: 'datagrip', args: ['.'], icon: '🗄' },
  { id: 'intellij', name: 'IntelliJ', command: 'idea', args: ['.'], icon: '💡' },
  { id: 'warp', name: 'Warp', command: 'warp', args: [], icon: '🟣' },
  { id: 'gnome-terminal', name: 'Terminal', command: 'gnome-terminal', args: ['--'], icon: '⬛' },
  { id: 'konsole', name: 'Konsole', command: 'konsole', args: [], icon: '⬛' },
  { id: 'alacritty', name: 'Alacritty', command: 'alacritty', args: [], icon: '⬛' },
  { id: 'kitty', name: 'Kitty', command: 'kitty', args: [], icon: '🐈' },
  { id: 'wezterm', name: 'WezTerm', command: 'wezterm', args: [], icon: '🟧' },
]

function isAvailable(cmd: string): boolean {
  try {
    const r = spawnSync('which', [cmd], { timeout: 2000 })
    return r.status === 0
  } catch {
    return false
  }
}

export function detectApps(): ExternalApp[] {
  return APP_CANDIDATES.filter((app) => isAvailable(app.command))
}

export function launchApp(appId: string, workspace: string): boolean {
  const app = APP_CANDIDATES.find((a) => a.id === appId)
  if (!app) return false
  try {
    const args = [...app.args]
    // For editors, replace '.' with the workspace path; for terminals, set cwd
    const finalArgs = args.map((a) => (a === '.' ? workspace : a))
    // Spawn detached so it survives grasp closing
    import('node:child_process').then(({ spawn }) => {
      const cp = spawn(app.command, finalArgs, {
        cwd: workspace,
        detached: true,
        stdio: 'ignore',
      })
      cp.unref()
    })
    return true
  } catch {
    return false
  }
}
