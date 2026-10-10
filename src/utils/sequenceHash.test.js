import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { hashSequence, SEQUENCE_SEPARATOR } from './sequenceHash'

// TEST_FIXTURE_KEEP's sequence (CLAUDE.md, "Test fixtures"), in the exact
// format SequenceBoardInput builds: `${from}${to}` per move, in drag order.
const FIXTURE_MOVES = ['c2c4', 'b2b4', 'a1a2', 'g1g2']

// Independent oracle: Node's own SHA-256, not the code under test.
function nodeSha256Hex(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

describe('hashSequence (Auth V2 D3, decision Q1)', () => {
  it('the separator is ASCII "|" (U+007C)', () => {
    expect(SEQUENCE_SEPARATOR).toBe('|')
    expect(SEQUENCE_SEPARATOR.codePointAt(0)).toBe(0x7c)
  })

  it('fixture vector: lowercase hex SHA-256 of "c2c4|b2b4|a1a2|g1g2"', async () => {
    const raw = FIXTURE_MOVES.join(SEQUENCE_SEPARATOR)
    expect(raw).toBe('c2c4|b2b4|a1a2|g1g2')
    const hash = await hashSequence(raw)
    console.log('[sequenceHash] fixture hash prefix', hash.slice(0, 12))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).toBe(nodeSha256Hex(raw))
    // Same prefix recorded in the step 2 investigation (separator section).
    expect(hash.startsWith('6236db405f89')).toBe(true)
  })

  it('reversed order hashes differently', async () => {
    const forward = await hashSequence(FIXTURE_MOVES.join(SEQUENCE_SEPARATOR))
    const reversed = await hashSequence([...FIXTURE_MOVES].reverse().join(SEQUENCE_SEPARATOR))
    expect(reversed).not.toBe(forward)
    expect(reversed.startsWith('f29b571b9711')).toBe(true)
  })

  it('a U+2502 separator would produce a different password (why Q1 matters)', async () => {
    const ascii = await hashSequence(FIXTURE_MOVES.join('|'))
    const boxDrawing = await hashSequence(FIXTURE_MOVES.join('│'))
    expect(boxDrawing).not.toBe(ascii)
  })
})
