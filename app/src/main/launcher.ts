// External app launcher — the editor/terminal switcher, mirroring ZCode's
// getInstalledEditors list (VS Code, Cursor, Zed, Trae, Sublime, JetBrains suite, Warp,
// Ghostty, terminals, Finder). ZCode reads the native macOS app icon; on Linux we detect
// the CLI and the renderer shows the bundled brand SVG (see components/editor-icons).
import { spawnSync } from 'node:child_process'

export interface ExternalApp {
  id: string
  name: string
  command: string // CLI to launch (Linux); editors take the workspace as an arg
  args: string[]
  icon: string // emoji fallback (renderer prefers <EditorIcon id>)
}

// ids align with components/editor-icons so the brand SVG resolves.
const APP_CANDIDATES: ExternalApp[] = [
  { id: 'vscode', name: 'VS Code', command: 'code', args: ['.'], icon: '◻' },
  { id: 'vscode-insiders', name: 'VS Code Insiders', command: 'code-insiders', args: ['.'], icon: '◻' },
  { id: 'cursor', name: 'Cursor', command: 'cursor', args: ['.'], icon: '◻' },
  { id: 'zed', name: 'Zed', command: 'zedit', args: ['.'], icon: '◻' },
  { id: 'trae', name: 'Trae', command: 'trae', args: ['.'], icon: '◻' },
  { id: 'sublime', name: 'Sublime Text', command: 'subl', args: ['.'], icon: '◻' },
  { id: 'neovim', name: 'Neovim', command: 'nvim', args: ['.'], icon: '◻' },
  { id: 'vim', name: 'Vim', command: 'vim', args: ['.'], icon: '◻' },
  { id: 'emacs', name: 'Emacs', command: 'emacs', args: ['.'], icon: '◻' },
  { id: 'idea', name: 'IntelliJ IDEA', command: 'idea', args: ['.'], icon: '◻' },
  { id: 'webstorm', name: 'WebStorm', command: 'webstorm', args: ['.'], icon: '◻' },
  { id: 'pycharm', name: 'PyCharm', command: 'pycharm', args: ['.'], icon: '◻' },
  { id: 'goland', name: 'GoLand', command: 'goland', args: ['.'], icon: '◻' },
  { id: 'phpstorm', name: 'PhpStorm', command: 'phpstorm', args: ['.'], icon: '◻' },
  { id: 'rider', name: 'Rider', command: 'rider', args: ['.'], icon: '◻' },
  { id: 'clion', name: 'CLion', command: 'clion', args: ['.'], icon: '◻' },
  { id: 'rubymine', name: 'RubyMine', command: 'rubymine', args: ['.'], icon: '◻' },
  { id: 'datagrip', name: 'DataGrip', command: 'datagrip', args: ['.'], icon: '◻' },
  { id: 'warp', name: 'Warp', command: 'warp', args: [], icon: '◻' },
  { id: 'ghostty', name: 'Ghostty', command: 'ghostty', args: [], icon: '◻' },
  { id: 'gnome-terminal', name: 'Terminal', command: 'gnome-terminal', args: ['--'], icon: '◻' },
  { id: 'konsole', name: 'Konsole', command: 'konsole', args: [], icon: '◻' },
  { id: 'alacritty', name: 'Alacritty', command: 'alacritty', args: [], icon: '◻' },
  { id: 'kitty', name: 'Kitty', command: 'kitty', args: [], icon: '◻' },
  { id: 'wezterm', name: 'WezTerm', command: 'wezterm', args: [], icon: '◻' },
  { id: 'finder', name: 'Files', command: 'xdg-open', args: ['.'], icon: '◻' }
]

// Accept a few alias commands so detection finds the app under its common binary name.
const ALIASES: Record<string, string[]> = {
  zed: ['zedit', 'zed'],
  'gnome-terminal': ['gnome-terminal', 'x-terminal-emulator']
}

function isAvailable(cmd: string): boolean {
  try {
    const r = spawnSync('which', [cmd], { timeout: 2000 })
    return r.status === 0
  } catch {
    return false
  }
}

export function detectApps(): ExternalApp[] {
  return APP_CANDIDATES.filter((app) => (ALIASES[app.id] ?? [app.command]).some((c) => isAvailable(c)))
}

export function launchApp(appId: string, workspace: string): boolean {
  const app = APP_CANDIDATES.find((a) => a.id === appId)
  if (!app) return false
  const cmd = (ALIASES[app.id]?.find((c) => isAvailable(c))) ?? app.command
  try {
    // Editors take the workspace as an argument; terminals use cwd; Files opens the dir.
    const finalArgs = app.args.map((a) => (a === '.' ? workspace : a))
    import('node:child_process').then(({ spawn }) => {
      const cp = spawn(cmd, finalArgs, { cwd: workspace, detached: true, stdio: 'ignore' })
      cp.unref()
    })
    return true
  } catch {
    return false
  }
}
