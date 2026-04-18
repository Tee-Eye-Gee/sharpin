import Anthropic from '@anthropic-ai/sdk'
import { getDifficultyInstruction } from '../src/utils/difficulty.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function buildPrompt({ fen, history, difficultyScore, timeControl, legalMoves }) {
  const difficultyInstruction = getDifficultyInstruction(difficultyScore)
  const recentMoves = history.length > 0 ? history.join(', ') : 'None — game just started'

  return `You are Theo, a chess-playing AI. You are playing as White against Tiggs (Black).

Current position (FEN): ${fen}
Recent moves: ${recentMoves}
Time control: ${timeControl}
Your performance level (0-100 scale): ${Math.round(difficultyScore)}

Difficulty instruction — follow this strictly:
${difficultyInstruction}

Legal moves available (UCI format): ${legalMoves.join(', ')}

Choose exactly ONE move from the legal moves list above.

Rules:
- The move MUST be from the legal moves list exactly as written.
- Do not explain your reasoning.
- The comment should be a single short quip, observation, or trash talk — or an empty string. Never analyse or justify the move.

Respond with ONLY this JSON, nothing else:
{"move": "<uci-move>", "comment": "<optional one-liner>"}`
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { fen, history, difficultyScore, timeControl, legalMoves } = req.body ?? {}

  if (!fen || !Array.isArray(legalMoves) || legalMoves.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  const prompt = buildPrompt({
    fen,
    history:         Array.isArray(history) ? history : [],
    difficultyScore: typeof difficultyScore === 'number' ? difficultyScore : 50,
    timeControl:     timeControl ?? 'casual',
    legalMoves,
  })

  try {
    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    })

    const text = message.content[0]?.text?.trim() ?? ''

    // Extract JSON from the response (strip any markdown fences)
    const cleaned = text.replace(/```json\n?|```\n?/g, '').trim()

    let parsed
    try {
      // Try direct parse first
      parsed = JSON.parse(cleaned)
    } catch {
      // Fall back to regex extraction
      const match = cleaned.match(/\{[^{}]+\}/)
      if (!match) {
        return res.status(200).json({ move: null, comment: '' })
      }
      parsed = JSON.parse(match[0])
    }

    const move    = typeof parsed.move    === 'string' ? parsed.move.trim()    : null
    const comment = typeof parsed.comment === 'string' ? parsed.comment.trim() : ''

    return res.status(200).json({ move, comment })
  } catch (err) {
    console.error('Claude API error:', err)
    return res.status(500).json({ error: 'Failed to get move from Claude' })
  }
}
