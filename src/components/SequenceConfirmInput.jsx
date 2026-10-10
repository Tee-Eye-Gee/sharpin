import { useRef, useState } from 'react'
import SequenceBoardInput from './SequenceBoardInput'

/**
 * Draw-twice wrapper around SequenceBoardInput (Auth V2 spec §5: a new
 * sequence is confirmed by drawing it a second time). Each round is a fresh
 * SequenceBoardInput mount (a new `key`), so the board needs no changes and
 * starts empty every time. Only the two hashes are compared -- the raw
 * moves never leave SequenceBoardInput.
 *
 * Match: calls onConfirmed(hash) and starts over at round one, so a failure
 * upstream (e.g. rate-limited) leaves a clean first-draw board. Mismatch:
 * says so and starts over at round one. Nothing here makes a network call.
 *
 * @param {object} props
 * @param {(hash: string) => void} props.onConfirmed
 * @param {boolean} [props.disabled]
 * @param {string} [props.boardTheme]
 */
export default function SequenceConfirmInput({ onConfirmed, disabled, boardTheme }) {
  // A ref, not just state: SequenceBoardInput calls back after an async
  // hash, so the comparison must read the value as of that moment.
  const firstHashRef = useRef(null)
  const [confirming, setConfirming] = useState(false)
  const [mismatch, setMismatch] = useState(false)
  const [round, setRound] = useState(0)

  function startOver() {
    firstHashRef.current = null
    setConfirming(false)
    setRound((r) => r + 1)
  }

  function handleComplete(hash) {
    if (firstHashRef.current === null) {
      firstHashRef.current = hash
      setMismatch(false)
      setConfirming(true)
      setRound((r) => r + 1)
      return
    }
    const matched = hash === firstHashRef.current
    setMismatch(!matched)
    startOver()
    if (matched) onConfirmed(hash)
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-fg-muted">
        {confirming ? 'Draw the same 4 moves again to confirm.' : 'Draw your 4-move sequence.'}
      </p>
      {mismatch && <p className="text-xs text-red-400">Those didn't match -- draw your sequence again.</p>}
      <SequenceBoardInput
        key={round}
        onSequenceComplete={handleComplete}
        disabled={disabled}
        boardTheme={boardTheme}
      />
      {confirming && !disabled && (
        <button onClick={startOver} className="text-xs text-fg-muted hover:text-fg underline text-center">
          Start over
        </button>
      )}
    </div>
  )
}
