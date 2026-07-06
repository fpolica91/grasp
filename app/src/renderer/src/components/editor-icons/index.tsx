// Editor / terminal brand icons — extracted from ZCode's own assets where it ships them
// (material-icons: vscode, sublime, vim) and from Simple Icons for the rest (Cursor, Zed,
// Warp, Ghostty, iTerm, JetBrains suite, Neovim, VSCodium). ZCode renders the native OS
// app icon at runtime; on Linux we ship the canonical brand SVGs instead. Pure-black fills
// (Cursor) are normalized to currentColor so they stay visible on the dark theme.
import vscodeRaw from './vscode.svg?raw'
import vscodiumRaw from './vscodium.svg?raw'
import cursorRaw from './cursor.svg?raw'
import zedRaw from './zed.svg?raw'
import warpRaw from './warp.svg?raw'
import ghosttyRaw from './ghostty.svg?raw'
import iterm2Raw from './iterm2.svg?raw'
import neovimRaw from './neovim.svg?raw'
import vimRaw from './vim.svg?raw'
import sublimeRaw from './sublimetext.svg?raw'
import ideaRaw from './intellijidea.svg?raw'
import webstormRaw from './webstorm.svg?raw'
import pycharmRaw from './pycharm.svg?raw'
import golandRaw from './goland.svg?raw'
import phpstormRaw from './phpstorm.svg?raw'
import rubymineRaw from './rubymine.svg?raw'
import clionRaw from './clion.svg?raw'
import datagripRaw from './datagrip.svg?raw'
import riderRaw from './rider.svg?raw'

const SVG: Record<string, string> = {
  vscode: vscodeRaw,
  'vscode-insiders': vscodeRaw,
  vscodium: vscodiumRaw,
  cursor: cursorRaw,
  zed: zedRaw,
  trae: '',
  warp: warpRaw,
  ghostty: ghosttyRaw,
  iterm2: iterm2Raw,
  terminal: '',
  'gnome-terminal': '',
  konsole: '',
  alacritty: '',
  kitty: '',
  wezterm: '',
  sublime: sublimeRaw,
  'sublime-text': sublimeRaw,
  neovim: neovimRaw,
  vim: vimRaw,
  emacs: '',
  idea: ideaRaw,
  'idea-ce': ideaRaw,
  intellij: ideaRaw,
  webstorm: webstormRaw,
  pycharm: pycharmRaw,
  goland: golandRaw,
  phpstorm: phpstormRaw,
  rider: riderRaw,
  clion: clionRaw,
  rubymine: rubymineRaw,
  datagrip: datagripRaw,
  codebuddy: '',
  qoder: '',
  finder: '',
  explorer: ''
}

// Monogram fallback for editors without a brand SVG (Trae, CodeBuddy, Qoder, Finder, …).
const MONOGRAM: Record<string, string> = {
  trae: 'T', codebuddy: 'C', qoder: 'Q',
  finder: '📂', explorer: '📂', terminal: '▸_', 'gnome-terminal': '▸_', konsole: '▸_',
  alacritty: '▸_', kitty: '▸_', wezterm: '▸_', emacs: 'E'
}

// Pure-black fills are invisible on the dark theme (Cursor ships fill="#000000").
// Normalize only those to currentColor so the icon picks up the foreground color.
function normalize(svg: string): string {
  return svg.replace(/fill="#0{3,6}"/gi, 'fill="currentColor"').replace(/fill="black"/gi, 'fill="currentColor"')
}

export function EditorIcon({ id, size = 16, className = '' }: { id: string; size?: number; className?: string }): React.JSX.Element {
  const raw = SVG[id]
  if (raw) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center [&>svg]:size-full ${className}`}
        style={{ width: size, height: size }}
        dangerouslySetInnerHTML={{ __html: normalize(raw) }}
      />
    )
  }
  const mg = MONOGRAM[id] ?? id.slice(0, 1).toUpperCase()
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-[5px] bg-secondary font-mono text-foreground-subtle ${className}`}
      style={{ width: size, height: size, fontSize: mg.length > 1 ? size * 0.42 : size * 0.62 }}
    >
      {mg}
    </span>
  )
}
