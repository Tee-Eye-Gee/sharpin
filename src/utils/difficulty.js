// Centipawn values for each piece type
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 }

/**
 * Sum material on the board for one color.
 * @param {Chess} chess
 * @param {'w'|'b'} color
 * @returns {number}
 */
function getMaterial(chess, color) {
  let total = 0
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq && sq.color === color) total += PIECE_VALUES[sq.type] ?? 0
    }
  }
  return total
}

/**
 * After Tiggs (black) has moved, check whether any black piece is now
 * capturable by white for a net material gain. chess must have white to move.
 *
 * Returns the highest net centipawn gain white can achieve by capturing
 * (0 if nothing hangs).
 *
 * @param {Chess} chess  — position after Tiggs's move (white to move)
 * @returns {number}
 */
function maxHangingValue(chess) {
  const moves = chess.moves({ verbose: true })
  let best = 0
  for (const m of moves) {
    if (m.captured) {
      const gain = (PIECE_VALUES[m.captured] ?? 0) - (PIECE_VALUES[m.piece] ?? 0)
      if (gain > best) best = gain
    }
  }
  return best
}

/**
 * Assess the quality of Tiggs's move.
 *
 * @param {Chess} chessBefore  — position before Tiggs moved (black to move)
 * @param {Chess} chessAfter   — position after Tiggs moved (white to move)
 * @returns {{ materialDelta: number, hangingValue: number }}
 */
export function assessMove(chessBefore, chessAfter) {
  const blackBefore = getMaterial(chessBefore, 'b')
  const whiteBefore = getMaterial(chessBefore, 'w')
  const blackAfter  = getMaterial(chessAfter,  'b')
  const whiteAfter  = getMaterial(chessAfter,  'w')

  // Net material change from black's perspective:
  // positive = black gained, negative = black lost
  const materialDelta = (blackAfter - blackBefore) - (whiteAfter - whiteBefore)

  // How much can white profitably capture after this move?
  const hangingValue = maxHangingValue(chessAfter)

  return { materialDelta, hangingValue }
}

/**
 * Update the 0-100 performance score based on move assessment.
 * Score decays toward 50 each move so Theo never locks in a read permanently.
 *
 * @param {number} score        — current score
 * @param {{ materialDelta: number, hangingValue: number }} assessment
 * @returns {number}            — new score, clamped to [0, 100]
 */
export function updatePerformanceScore(score, assessment) {
  const { materialDelta, hangingValue } = assessment
  let delta = 0

  // Material gain rewards
  if (materialDelta >= 300)      delta += 12
  else if (materialDelta >= 100) delta +=  5
  else if (materialDelta >    0) delta +=  2

  // Material loss penalties
  if      (materialDelta <= -300) delta -= 18
  else if (materialDelta <= -100) delta -= 10
  else if (materialDelta <     0) delta -=  4

  // Hanging-piece penalty (Tiggs left material en prise)
  if      (hangingValue >= 900) delta -= 20
  else if (hangingValue >= 500) delta -= 14
  else if (hangingValue >= 300) delta -= 10
  else if (hangingValue >= 100) delta -=  5

  // Gentle decay toward 50 — Theo re-reads Tiggs's form over time
  const decayed = score * 0.93 + 50 * 0.07

  return Math.max(0, Math.min(100, decayed + delta))
}

/**
 * Human-readable label for the current difficulty band.
 * @param {number} score
 * @returns {string}
 */
export function getDifficultyLabel(score) {
  if (score <= 30) return 'Casual'
  if (score <= 55) return 'Solid'
  if (score <= 75) return 'Competitive'
  return 'Sharp'
}

/**
 * Instruction string injected into Claude's prompt.
 * @param {number} score
 * @returns {string}
 */
export function getDifficultyInstruction(score) {
  if (score <= 30) {
    return (
      'Play at a casual, beginner-friendly level. Make simple, safe moves. ' +
      'Do NOT seek sharp tactics or combinations. ' +
      'Roughly 1-in-3 moves, deliberately overlook a free piece or obvious tactic. ' +
      'Keep the game low-pressure and comfortable.'
    )
  }
  if (score <= 55) {
    return (
      'Play solid, reasonable chess but not your best. ' +
      'Miss tactical opportunities occasionally. Let small positional advantages slip. ' +
      'Play like a club player who knows the basics but is not calculating deeply.'
    )
  }
  if (score <= 75) {
    return (
      'Play competitive chess. Find clear tactics when they appear. ' +
      'Defend actively and seek a slight positional advantage. ' +
      'Play like a motivated club player who is focused and making good moves.'
    )
  }
  return (
    'Play near your strongest. Make well-considered tactical and strategic moves. ' +
    'Aim for the best continuation, though you may occasionally miss a very deep combination. ' +
    'Challenge the player to find precise moves to hold on or win.'
  )
}
