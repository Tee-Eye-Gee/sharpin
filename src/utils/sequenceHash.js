// The move-sequence password (Auth V2 spec D3, decision Q1): the lowercase
// hex SHA-256 of the 4 board-drawn moves, each `${from}${to}` (e.g. 'c2c4'),
// joined in order with ASCII '|' (U+007C). Existing hashes depend on this
// exact format -- TEST_FIXTURE_KEEP's stored hash is its future password
// (D8) -- so neither the separator nor the encoding may change.
export const SEQUENCE_SEPARATOR = '|'

// Carried over unchanged from SequenceBoardInput.jsx.
export async function hashSequence(raw) {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
