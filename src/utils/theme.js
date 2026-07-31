// Board square color presets — see docs/specs/Sharpin_Spec_ColorScheme.md §2.
// Piece colors stay black/white across all of these; only squares change.
export const BOARD_THEMES = {
  tournament: { label: 'Tournament', light: '#EEEED2', dark: '#769656' },
  wood: { label: 'Wood', light: '#F0D9B5', dark: '#B58863' },
  offBlackWhite: { label: 'Off-black / Off-white', light: '#DCDCDC', dark: '#444444' },
  classic: { label: 'Classic', light: '#4A4A4A', dark: '#2C2C2C' },
}

export const DEFAULT_BOARD_THEME = 'tournament'

// App-wide light/dark tokens — see spec §3. Panel/surface and border shades
// aren't in the spec's table (only background/text/accent are); dark mode
// keeps the app's existing values (spec calls the dark background
// "unchanged" and doesn't touch these), light mode's surface/border are
// derived (white panels, light-gray border) per product sign-off.
// Stored as space-separated RGB triples so Tailwind's `rgb(var(--x) /
// <alpha-value>)` pattern can apply opacity modifiers (bg-accent/10, etc.)
// consistently in both modes — see tailwind.config.js.
const APP_MODE_TOKENS = {
  dark: {
    bg: '15 15 15',
    surface: '20 20 20',
    border: '30 30 30',
    borderStrong: '42 42 42',
    fg: '245 245 245',
    fgMuted: '176 176 176',
    accent: '232 185 35',
  },
  light: {
    bg: '250 250 250',
    surface: '255 255 255',
    border: '224 224 224',
    borderStrong: '204 204 204',
    fg: '26 26 26',
    fgMuted: '74 74 74',
    accent: '184 134 11',
  },
}

function hexToRgbTriple(hex) {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `${r} ${g} ${b}`
}

function toKebabCase(key) {
  return key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
}

/**
 * The current mode's accent color as an rgba() string, for the handful of
 * spots (react-chessboard's inline square styles) that can't consume a
 * Tailwind class and need a literal color value instead. Reuses the same
 * token source as everything else rather than duplicating the hex.
 */
export function accentRgba(appMode, alpha = 1) {
  const tokens = APP_MODE_TOKENS[appMode] ?? APP_MODE_TOKENS.dark
  return `rgba(${tokens.accent.replace(/ /g, ', ')}, ${alpha})`
}

/**
 * OS-level color scheme preference. Only consulted on first load, before any
 * stored preference exists — once the user toggles manually, the app must
 * not re-detect on later visits (spec §3).
 */
export function detectSystemAppMode() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Apply an app mode + board theme to the document root as CSS custom
 * properties. Components read these via Tailwind color tokens (bg-bg,
 * text-fg, bg-accent/10, ...) defined in tailwind.config.js, so switching
 * either value re-themes every component that uses those tokens.
 */
export function applyTheme(appMode, boardThemeId) {
  const root = document.documentElement
  const tokens = APP_MODE_TOKENS[appMode] ?? APP_MODE_TOKENS.dark
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(`--color-${toKebabCase(key)}`, value)
  }

  const board = BOARD_THEMES[boardThemeId] ?? BOARD_THEMES[DEFAULT_BOARD_THEME]
  root.style.setProperty('--board-light', hexToRgbTriple(board.light))
  root.style.setProperty('--board-dark', hexToRgbTriple(board.dark))

  root.dataset.appMode = appMode
}
