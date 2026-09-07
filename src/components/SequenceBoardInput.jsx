import { useState, useRef, useEffect } from 'react'
import { Chessboard } from 'react-chessboard'
import { BOARD_THEMES, DEFAULT_BOARD_THEME } from '../utils/theme'

// Anderssen vs. Kieseritzky, "The Immortal Game" (1851), the position after
// 11...cxb5 -- fixed identically for every attempt (Create Account and
// Login) so a chosen sequence stays reproducible. Spec:
// docs/specs/Sharpin_Spec_SequenceInput.md §2.
const START_FEN = 'rnb1kb1r/p2p1ppp/5n2/1p3Nq1/4PpP1/3P4/PPP4P/RNBQ1KR1 w kq - 0 12'
const SEQUENCE_LENGTH = 4

// react-chessboard doesn't export a FEN parser from its package root (only
// Chessboard/ChessboardDnDProvider/SparePiece are, per node_modules/
// react-chessboard/dist/index.esm.js's export line -- convertPositionToObject/
// fenToObj exist internally but aren't re-exported), so the one-time
// conversion from the fixed starting FEN to a { square: piece } position
// object -- the shape every step's snapshot below uses -- is done here.
// Piece-placement field only; turn/castling/etc. are irrelevant since no
// chess.js or legality is involved anywhere in this component.
function fenToPosition(fen) {
  const position = {}
  const [placement] = fen.split(' ')
  placement.split('/').forEach((rankStr, rankIndex) => {
    const rank = 8 - rankIndex
    let file = 0
    for (const char of rankStr) {
      if (/\d/.test(char)) {
        file += Number(char)
        continue
      }
      const square = `${String.fromCharCode(97 + file)}${rank}`
      const color = char === char.toUpperCase() ? 'w' : 'b'
      position[square] = `${color}${char.toUpperCase()}`
      file += 1
    }
  })
  return position
}

const START_POSITION = fenToPosition(START_FEN)

// Carried over unchanged from the placeholder this component replaces.
async function hashSequence(raw) {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Board-gesture sequence input (spec: docs/specs/Sharpin_Spec_SequenceInput.md).
 * Replaces the plain-text placeholder -- drives the exact same swap-boundary
 * contract (`onSequenceComplete(hash)`, a single hex-SHA-256 string, fired
 * once on the 4th drag) without touching anything else in LaunchOverlay.
 *
 * No chess.js, no legality: any piece, any color, any square. Landing on an
 * occupied square overwrites it. State is a linear array of full-position
 * snapshots (index 0 = the fixed start position), one snapshot appended per
 * completed drag -- Back pops the last snapshot (and its move), Reset drops
 * back to just the start snapshot.
 *
 * @param {object} props
 * @param {(hash: string) => void} props.onSequenceComplete
 * @param {boolean} [props.disabled] - true while a request is in flight
 *   upstream, or the flow is otherwise gated (e.g. rate-limited) -- board
 *   and Back/Reset are inert, same intent as the old placeholder's
 *   `disabled` prop.
 * @param {string} [props.boardTheme] - the user's selected board theme id
 *   (Settings > Board Theme), same value App.jsx passes to Board.jsx.
 */
export default function SequenceBoardInput({ onSequenceComplete, disabled, boardTheme }) {
  const { light: lightSquare, dark: darkSquare } = BOARD_THEMES[boardTheme] ?? BOARD_THEMES[DEFAULT_BOARD_THEME]
  const [positions, setPositions] = useState([START_POSITION])
  const [moves, setMoves] = useState([])
  // True from the moment the 4th drag has fired onSequenceComplete. Distinct
  // from moves.length === SEQUENCE_LENGTH so the reset effect below (which
  // clears moves back to []) still has a reliable signal that a submission
  // already happened this mount.
  const submittedRef = useRef(false)

  // LaunchOverlay only ever sets `disabled` as a downstream consequence of
  // this component's own submission (see handleLogin/handleCreateAccount) --
  // submitting while the request is in flight, then back to false on a
  // failure that keeps the overlay open (a no-match login, a 409 sequence
  // collision). A real success instead calls onAuthenticated and the whole
  // overlay unmounts, so this effect never fires for that path. Without
  // this, a failed attempt would leave the board permanently locked after
  // its 4th move with no way to draw a new sequence -- unlike the
  // placeholder it replaces, which never locked itself.
  const prevDisabledRef = useRef(disabled)
  useEffect(() => {
    if (prevDisabledRef.current && !disabled && submittedRef.current) {
      submittedRef.current = false
      setPositions([START_POSITION])
      setMoves([])
    }
    prevDisabledRef.current = disabled
  }, [disabled])

  const currentPosition = positions[positions.length - 1]
  const moveCount = moves.length
  const canInteract = !disabled && !submittedRef.current && moveCount < SEQUENCE_LENGTH
  const showCorrectionControls = moveCount > 0 && moveCount < SEQUENCE_LENGTH

  async function submitSequence(finalMoves) {
    const hash = await hashSequence(finalMoves.join('|'))
    onSequenceComplete(hash)
  }

  function handlePieceDrop(sourceSquare, targetSquare, piece) {
    if (!canInteract) return false

    const nextPosition = { ...currentPosition }
    delete nextPosition[sourceSquare]
    nextPosition[targetSquare] = piece

    const nextMoves = [...moves, `${sourceSquare}${targetSquare}`]
    setPositions((prev) => [...prev, nextPosition])
    setMoves(nextMoves)

    if (nextMoves.length === SEQUENCE_LENGTH) {
      submittedRef.current = true
      submitSequence(nextMoves)
    }

    return true
  }

  function handleBack() {
    if (!showCorrectionControls || disabled) return
    setPositions((prev) => prev.slice(0, -1))
    setMoves((prev) => prev.slice(0, -1))
  }

  function handleReset() {
    if (!showCorrectionControls || disabled) return
    setPositions([START_POSITION])
    setMoves([])
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-fg-muted uppercase tracking-widest font-medium text-center">
        Anderssen vs. Kieseritzky
        <br />
        The Immortal Game (1851)
      </p>

      <Chessboard
        id="sequence-board-input"
        position={currentPosition}
        onPieceDrop={handlePieceDrop}
        onPromotionCheck={() => false}
        boardOrientation="white"
        arePiecesDraggable={canInteract}
        animationDuration={200}
        customLightSquareStyle={{ backgroundColor: lightSquare }}
        customDarkSquareStyle={{ backgroundColor: darkSquare }}
      />

      {showCorrectionControls && (
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={handleBack}
            disabled={disabled}
            className="text-xs text-fg-muted hover:text-fg underline text-center"
          >
            Undo
          </button>
          <button
            onClick={handleReset}
            disabled={disabled}
            className="rounded-lg border border-border px-3 py-2 text-sm text-fg transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Reset
          </button>
        </div>
      )}
    </div>
  )
}
