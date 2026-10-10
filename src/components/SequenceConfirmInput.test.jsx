// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

// The real board needs drag gestures; this stub emits whatever hash the
// test queues next and counts mounts, so the per-round remount is visible.
let queuedHashes = []
let mounts = 0
vi.mock('./SequenceBoardInput', async () => {
  const { useEffect } = await import('react')
  return {
    default: function StubBoard({ onSequenceComplete, disabled }) {
      useEffect(() => { mounts += 1 }, [])
      return (
        <button disabled={disabled} onClick={() => onSequenceComplete(queuedHashes.shift())}>
          complete-sequence
        </button>
      )
    },
  }
})

const fetchSpy = vi.fn()

const { default: SequenceConfirmInput } = await import('./SequenceConfirmInput')

beforeEach(() => {
  queuedHashes = []
  mounts = 0
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SequenceConfirmInput: draw twice', () => {
  it('matching second draw calls onConfirmed with the hash, once', () => {
    queuedHashes = ['a'.repeat(64), 'a'.repeat(64)]
    const onConfirmed = vi.fn()
    render(<SequenceConfirmInput onConfirmed={onConfirmed} />)
    expect(screen.getByText('Draw your 4-move sequence.')).toBeTruthy()

    fireEvent.click(screen.getByText('complete-sequence'))
    expect(screen.getByText('Draw the same 4 moves again to confirm.')).toBeTruthy()
    expect(onConfirmed).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('complete-sequence'))
    expect(onConfirmed).toHaveBeenCalledTimes(1)
    expect(onConfirmed).toHaveBeenCalledWith('a'.repeat(64))
    // A fresh board for each round: first, confirm, then back to first.
    expect(mounts).toBe(3)
  })

  it('mismatch says so, resets to the first draw with a fresh board, and makes no network call', () => {
    queuedHashes = ['a'.repeat(64), 'b'.repeat(64)]
    const onConfirmed = vi.fn()
    render(<SequenceConfirmInput onConfirmed={onConfirmed} />)

    fireEvent.click(screen.getByText('complete-sequence'))
    fireEvent.click(screen.getByText('complete-sequence'))

    expect(onConfirmed).not.toHaveBeenCalled()
    expect(screen.getByText("Those didn't match -- draw your sequence again.")).toBeTruthy()
    expect(screen.getByText('Draw your 4-move sequence.')).toBeTruthy()
    expect(mounts).toBe(3)
    expect(fetchSpy).not.toHaveBeenCalled()

    // After a mismatch the next pair starts from scratch.
    queuedHashes = ['c'.repeat(64), 'c'.repeat(64)]
    fireEvent.click(screen.getByText('complete-sequence'))
    fireEvent.click(screen.getByText('complete-sequence'))
    expect(onConfirmed).toHaveBeenCalledWith('c'.repeat(64))
  })

  it('Start over discards the first draw', () => {
    queuedHashes = ['a'.repeat(64), 'b'.repeat(64), 'b'.repeat(64)]
    const onConfirmed = vi.fn()
    render(<SequenceConfirmInput onConfirmed={onConfirmed} />)

    fireEvent.click(screen.getByText('complete-sequence'))
    fireEvent.click(screen.getByText('Start over'))
    expect(screen.getByText('Draw your 4-move sequence.')).toBeTruthy()

    fireEvent.click(screen.getByText('complete-sequence'))
    fireEvent.click(screen.getByText('complete-sequence'))
    expect(onConfirmed).toHaveBeenCalledWith('b'.repeat(64))
  })
})
