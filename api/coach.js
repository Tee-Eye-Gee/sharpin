import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function buildPrompt({ themes, solved, movesPlayed, timeTakenMs, weakThemes }) {
  const seconds = Math.round(timeTakenMs / 1000)
  const themeList = themes.length > 0 ? themes.join(', ') : 'untagged'
  const moveList = movesPlayed.length > 0 ? movesPlayed.join(' ') : 'none recorded'

  const weakPatternContext = weakThemes.length > 0
    ? weakThemes.map((w) => `${w.theme} (${Math.round(w.accuracy * 100)}% over ${w.attempts} attempts)`).join(', ')
    : 'none yet — not enough history'

  return `You are the coaching voice inside Sharpin, a chess puzzle trainer. You never played this puzzle, generated it, or verified its legality — the puzzle came from a pre-verified dataset. Your only job is to comment on the player's attempt and note any recurring weak pattern.

Puzzle themes: ${themeList}
Outcome: ${solved ? 'Solved' : 'Failed'}
Moves played this attempt: ${moveList}
Time taken: ${seconds}s
Player's known weak themes (from their history, worst-first): ${weakPatternContext}

Write a short coaching note for this attempt:
- One or two sentences, plain text, no markdown, no move analysis or engine-style annotation.
- If solved: a brief affirming note. If failed: brief, non-discouraging note about what to look for next time.
- If the puzzle's themes overlap with the player's known weak themes, mention that connection briefly — this is the "running weak-pattern" coaching signal. If there's no overlap or no history yet, skip that part rather than forcing it.
- Never invent a better move or claim what "should" have been played — you don't adjudicate positions.

Respond with ONLY this JSON, nothing else:
{"note": "<your coaching note>"}`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { themes, solved, movesPlayed, timeTakenMs, weakThemes } = req.body ?? {}

  if (typeof solved !== 'boolean' || !Array.isArray(themes)) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  const prompt = buildPrompt({
    themes,
    solved,
    movesPlayed: Array.isArray(movesPlayed) ? movesPlayed : [],
    timeTakenMs: typeof timeTakenMs === 'number' ? timeTakenMs : 0,
    weakThemes: Array.isArray(weakThemes) ? weakThemes : [],
  })

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = message.content[0]?.text?.trim() ?? ''
    const cleaned = text.replace(/```json\n?|```\n?/g, '').trim()

    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      const match = cleaned.match(/\{[^{}]+\}/)
      if (!match) {
        return res.status(200).json({ note: '' })
      }
      parsed = JSON.parse(match[0])
    }

    const note = typeof parsed.note === 'string' ? parsed.note.trim() : ''
    return res.status(200).json({ note })
  } catch (err) {
    console.error('Claude API error:', err)
    return res.status(500).json({ error: 'Failed to get coaching note' })
  }
}
