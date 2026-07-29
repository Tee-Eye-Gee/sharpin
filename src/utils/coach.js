import { formatTheme } from './themeLabels'

const RECENT_PER_THEME = 10 // how many of a theme's most recent attempts to look at
const MIN_THEME_SAMPLE = 5  // need at least this many recent attempts of a theme to flag it
const WEAKNESS_GAP = 0.15   // theme's recent solve rate must trail overall rate by this much

function themeRecentStats(attempts, theme) {
  const recent = attempts.filter((a) => a.themes?.includes(theme)).slice(0, RECENT_PER_THEME)
  const solved = recent.filter((a) => a.solved).length
  return { sample: recent.length, solved }
}

// Worst underperforming theme among `candidateThemes`, or null if none clear
// the minimum sample size and weakness-gap bar.
function findWeakTheme(attempts, overallRate, candidateThemes) {
  let worst = null
  for (const theme of candidateThemes) {
    const { sample, solved } = themeRecentStats(attempts, theme)
    if (sample < MIN_THEME_SAMPLE) continue
    const rate = solved / sample
    const gap = overallRate - rate
    if (gap >= WEAKNESS_GAP && (!worst || gap > worst.gap)) {
      worst = { theme, sample, solved, gap }
    }
  }
  return worst
}

/**
 * Rule-based, fully local replacement for the old Claude-backed coach note:
 * no network call, no API key. Surfaces a weak-pattern callout when one
 * theme's recent solve rate meaningfully trails the player's overall solve
 * rate, otherwise falls back to streak/encouragement messaging.
 *
 * @param {object} params
 * @param {string[]} params.themes   — themes of the puzzle just attempted
 * @param {boolean} params.solved
 * @param {object} params.profile    — updated profile (post-attempt counts)
 * @param {object[]} params.attempts — full attempt history, newest first
 * @returns {string}
 */
export function generateCoachNote({ themes, solved, profile, attempts }) {
  const totalAttempts = profile.totalSolved + profile.totalFailed
  const overallRate = totalAttempts > 0 ? profile.totalSolved / totalAttempts : 0

  // Prefer a weak theme relevant to the puzzle just played; otherwise
  // surface the single worst weak theme across the player's whole history.
  const allThemes = [...new Set(attempts.flatMap((a) => a.themes ?? []))]
  const weak = findWeakTheme(attempts, overallRate, themes)
    ?? findWeakTheme(attempts, overallRate, allThemes)

  if (weak) {
    const pct = Math.round(overallRate * 100)
    return `Weak pattern: ${formatTheme(weak.theme)} (${weak.solved}/${weak.sample} solved recently, vs ${pct}% overall)`
  }

  if (solved) {
    const streak = profile.currentStreak
    if (streak >= 5) return `${streak} in a row — on a roll.`
    if (streak >= 2) return `Nice, ${streak} in a row.`
    return 'Solved — nice work.'
  }

  return totalAttempts < MIN_THEME_SAMPLE
    ? 'Not quite — keep going, patterns will show up with more attempts.'
    : 'Not quite — no clear weak spot yet, keep going.'
}
