# Sharpin — Backlog Item #1: Color Scheme & Theming Update
Spec for review · July 30, 2026 · Sterling Axis

## 1. Goal
Replace the single fixed dark/amber theme with: (a) a selectable board color theme, (b) a full app-wide light/dark mode toggle, (c) improved text contrast in dark mode. Triggered by current board being hard to see (gray-on-gray, low contrast).

## 2. Board Themes (4 presets)

| Theme | Light square | Dark square | Notes |
|---|---|---|---|
| Tournament (new default) | `#EEEED2` | `#769656` | Standard green/cream tournament look, per reference image |
| Wood | `#F0D9B5` | `#B58863` | Classic wood look, per reference image |
| Off-black / off-white | `#DCDCDC` | `#444444` | Deliberately not true black/white — avoids black pieces disappearing on black squares |
| Classic (existing, renamed) | `#4A4A4A` | `#2C2C2C` | Current board, kept as an option, not the default |

Board theme selection is **independent of light/dark app mode** — last-selected theme persists regardless of which app mode is active.

**Tournament (green/off-white) is the default shown on first load**, before any user customization. Once a user selects a different theme via the settings panel, their choice persists and overrides the default on all future sessions.

## 3. App Light/Dark Mode (full second theme)

| Element | Dark mode | Light mode |
|---|---|---|
| Background | `#0f0f0f` (unchanged) | `#FAFAFA` (new) |
| Panel/card background | `#141414` (unchanged) | `#FFFFFF` (new) |
| Border | `#1e1e1e`/`#2a2a2a` (unchanged) | `#E0E0E0` (new) |
| Primary text | `#F5F5F5` (brightened from current) | `#1A1A1A` |
| Secondary text | `#B0B0B0` (brightened — addresses the "hard to see gray" complaint) | `#4A4A4A` |
| Accent | `#E8B923` (brightened amber, better contrast on dark panels) | `#B8860B` (darkened amber — full-brightness gold has poor contrast on white) |

Colors are stored as CSS custom properties in RGB-triple form (not hex strings) so Tailwind opacity modifiers (`bg-accent/10`, `border-accent/30`) work correctly in both themes — implementation detail confirmed during build, not originally specced.

On first load (no stored preference yet), app mode is auto-detected from the OS via `prefers-color-scheme`. Once the user toggles manually, their choice overrides system preference and is persisted — the app does not re-detect on subsequent visits.

## 4. Header / Navigation (new component)

Based on reference layout (Fluency):

- **Top-left:** app wordmark, plain styled text — **"Sharpin" custom logo/branding treatment is explicitly out of scope for this item.** Log separately if wanted.
- **Top-right, two controls:**
  - **Sun icon** — instant dark/light toggle, no submenu
  - **Gear icon** (changed from hamburger per your note) — opens a settings panel
    - Currently contains: board theme selector only (4 options above)
    - Designed to hold future settings (difficulty — see backlog below) without restructuring

## 5. Persistence
New `preferences` key in IndexedDB (alongside existing rating/history/streak data), storing:
```
{ appMode: "dark" | "light", boardTheme: "tournament" | "wood" | "offBlackWhite" | "classic" }
```
Defaults: `appMode: null` until first detection (then set from `prefers-color-scheme` and persisted), `boardTheme: "tournament"`.

## 6. New/Modified Files
- **New:** `src/components/Header.jsx` — wordmark + sun toggle + gear icon
- **New:** `src/components/SettingsPanel.jsx` — board theme selector (opened by gear icon)
- **New:** `src/utils/theme.js` — theme + board-theme definitions, CSS variable mapping
- **Modified:** `src/utils/storage.js` — add `preferences` get/set functions
- **Modified:** `src/App.jsx` — mount `Header.jsx`, apply theme CSS variables at root

## 7. Explicitly Out of Scope (this item)
- Custom logo/wordmark styling for "Sharpin" (separate backlog candidate if wanted)
- Difficulty setting (added to backlog as new item — see below)

## 8. Backlog Update
Difficulty setting added as new item, appended to end of ordered queue (no urgency signal, placeholder for the gear-icon settings panel to grow into):

| # | Item |
|---|---|
| 1 | Color scheme update *(this spec)* |
| 2 | Click-to-move input rework |
| 3 | Puzzle retry / re-attempt |
| 4 | Tactical lexicon |
| 5 | Hint system |
| 6 | Placement quiz |
| 7 | Timed / Puzzle Rush mode |
| 8 | Offline / installable PWA |
| 9 | Analytics instrumentation |
| 10 | Difficulty setting *(new)* |
| — | Cross-device sync (conditional, unranked) |

## 9. Piece Styling
Standard vector piece construction: solid black or white fill, thin black (~1px at board scale) stroke around every outer and inner edge of the silhouette. Enclosed interior shapes (e.g. the gaps in a crown) are transparent, not filled — the square color underneath shows through. Piece colors stay black/white across all 4 board themes; no per-theme recoloring. This is very likely `react-chessboard`'s default piece rendering already — check the default set against this description before building anything custom. Only build custom pieces if the default set doesn't already meet it.

## 10. Kill Switch
If implementing theme.js requires touching hardcoded colors scattered across multiple components (instead of all components already referencing shared CSS variables), stop — that means the original build didn't centralize color, and this is now a larger refactor than a theming task. Flag before continuing.
