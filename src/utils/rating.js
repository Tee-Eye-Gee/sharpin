// Baseline rating for a brand-new profile — placement quiz is deferred (backlog),
// so every user starts here until their history shifts it.
export const DEFAULT_RATING = 1200

export const BAND_SIZE = 200
export const MIN_BAND = 200
export const MAX_BAND = 3200

const K_FACTOR = 24

/**
 * Standard Elo expected-score formula.
 * @param {number} ratingA
 * @param {number} ratingB
 * @returns {number} probability (0-1) that A "beats" B
 */
function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
}

/**
 * Update a user's rating after a puzzle attempt.
 * @param {number} userRating   — rating before this attempt
 * @param {number} puzzleRating — the puzzle's own Lichess rating
 * @param {boolean} solved      — whether the user solved it
 * @returns {{ newRating: number, delta: number }}
 */
export function updateRating(userRating, puzzleRating, solved) {
  const expected = expectedScore(userRating, puzzleRating)
  const actual = solved ? 1 : 0
  const delta = Math.round(K_FACTOR * (actual - expected))
  const newRating = Math.max(100, userRating + delta)
  return { newRating, delta: newRating - userRating }
}

/**
 * Rating band (200-point wide) a given rating falls into, clamped to the
 * range actually present in the dataset.
 * @param {number} rating
 * @returns {{ min: number, max: number, file: string }}
 */
export function bandForRating(rating) {
  const clamped = Math.min(MAX_BAND, Math.max(MIN_BAND, rating))
  const min = Math.floor(clamped / BAND_SIZE) * BAND_SIZE
  const max = min + BAND_SIZE - 1
  return { min, max, file: `${min}-${max}.json` }
}

/**
 * Ordered list of candidate bands to try, nearest-first, for when the
 * user's home band doesn't have enough puzzles left to pick from.
 * @param {number} rating
 * @param {number} radius — how many bands out on each side to include
 * @returns {{ min: number, max: number, file: string }[]}
 */
export function nearestBands(rating, radius = 2) {
  const home = bandForRating(rating)
  const bands = [home]
  for (let i = 1; i <= radius; i++) {
    const lower = home.min - i * BAND_SIZE
    const upper = home.min + i * BAND_SIZE
    if (lower >= MIN_BAND) bands.push(bandForRating(lower))
    if (upper <= MAX_BAND) bands.push(bandForRating(upper))
  }
  return bands
}
