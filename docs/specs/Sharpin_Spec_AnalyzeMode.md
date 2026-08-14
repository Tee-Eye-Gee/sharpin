# Sharpin — Analyze Mode Spec (v1 draft)

**Status:** Spec drafted, NOT yet investigated, NOT yet backlog-ordered.
**Created:** 2026-08-09

---

## 1. Goal

After finishing a puzzle, allow the user to enter a free-exploration "Analyze"
mode: replay the puzzle from its start position, play any legal move (not
gated to the puzzle's solution), and see live engine evaluation — multiple
candidate lines, best-move arrow, eval score — updating as moves are made.

This is distinct from puzzle-solving mode: no correct/incorrect judgment, no
scoring, no retry mechanics. It's a sandbox layered on top of a puzzle
position.

---

## 2. Entry Point

- New "Analyze" button on the puzzle-finish screen (alongside existing
  Retry / Next Puzzle row).
- **CONFIRMED:** Analyze mode loads the puzzle's **starting FEN**, not its
  final position — the user replays the full sequence and can branch off
  anywhere along it.
- **CONFIRMED:** The Analyze option only appears on a **successful** finish
  — "Solved" or "Solved - hint used." A "Not quite" outcome shows no
  Analyze affordance. No analysis affordance exists anywhere before the
  puzzle has been completed — no early-exit analysis, no analysis
  mid-attempt.

---

## 3. Engine

- **Stockfish, client-side, via WASM in a Web Worker.**
- Not an external API call (ruled out Lichess cloud-eval and third-party
  hosted engines — see decision log below for why).
- MultiPV = 3 (three simultaneous candidate lines), confirmed default.
- Depth: mobile and desktop likely need different defaults given hardware
  variance. Starting point for investigation: ~12–15 depth on mobile,
  deeper (~18–20) on desktop — **not locked**, needs real-device
  performance verification before committing to numbers.
- Async handling: rapid user moves must cancel in-flight eval requests,
  not just ignore stale results — a stale depth-N result landing after
  the user has already moved again must not overwrite the current
  position's display. This is a real bug class, not an edge case; explicit
  handling required, not assumed to "just work."

---

## 4. Board Interaction

- **Arrow overlay for best move** — NEW capability, in scope for v1.
  Board.jsx currently supports square highlighting (hint tiers, last-move,
  tap-selection) but not arrow rendering. This requires new SVG-overlay
  logic layered on the board, following the same "layer after existing
  styling, don't replace it" pattern used for hint highlights.
- Free move input — not gated to a single correct solution. This is a
  meaningfully different interaction mode from puzzle-solving; Board.jsx's
  move-acceptance logic needs a mode flag or equivalent, not silent reuse
  of puzzle-mode gating.
- Move-list / line display: 3 lines shown by default, each with eval score
  and move sequence. Tap-to-jump-into-line behavior implied by the
  reference screenshot but not yet explicitly confirmed — flag as an
  open question below.
- Move history navigation: Back / Forward through the currently-explored
  line.

---

## 5. Persistence

- **Ephemeral for v1.** Analysis state is not written to IndexedDB. Leaving
  Analyze mode discards the current exploration.
- Decision reasoning: a "resume where I left off" model raises unresolved
  questions (one active session vs. history of sessions; what happens when
  a different puzzle's Analyze mode is opened while one is "in progress")
  that amount to a second feature, not a detail of this one. Ephemeral
  avoids that scope creep for v1.
- **Fast-follow candidate, NOT in v1 scope:** an explicit "Save this line"
  action that snapshots the current move sequence to IndexedDB on demand,
  rather than silent auto-persistence. Log as a separate backlog item if
  pursued later.

---

## 6. Explicitly Out of Scope (v1)

- **"Explore" button (opening/game database lookup).** Conscious decision,
  not an oversight — this is a different data source and feature entirely
  (game/opening database vs. local puzzle-derived analysis). Revisit later
  if wanted; do not silently fold in.
- Auto-persistence / resume (see §5).
- Saving/exporting analysis lines.

---

## 7. Architecture Impact

- **New dependency:** Stockfish WASM asset (~5–10MB). Must be lazy-loaded
  only when Analyze mode is opened — must not add to initial app load /
  puzzle-solving cold-start time.
- **New pattern:** first Web Worker in the codebase.
- **Button-row logic change:** this is the first feature where the
  post-finish button row differs by outcome. Existing states (§4.5,
  Master Context V9) show Retry + Next Puzzle uniformly on any finish,
  success or fail. Analyze being success-only means `PuzzleControls.jsx`
  needs a genuine new conditional branch, not an appended button on the
  existing row — flag for investigation to confirm this doesn't tangle
  with the current 4-state row logic more than expected.
- **No IndexedDB schema change** (v1 is ephemeral — confirmed consistent
  with current schema v2, no migration needed).
- **No backend, no external API call** — stays consistent with Sharpin's
  existing $0 / local-only / no-external-dependency architecture. This was
  the deciding factor over Lichess cloud-eval or third-party hosted engine
  APIs, which would have introduced an external runtime dependency,
  rate-limit exposure, and — for cloud-eval specifically — unreliable
  coverage the moment the user deviates from the puzzle's original line
  into their own explored moves.

---

## 8. Open Questions for Investigation (when this reaches the front of backlog)

1. Confirm entry-position assumption (§2) — starting FEN vs. final position.
2. Real-device performance testing to lock mobile/desktop depth defaults
   (§3) — current numbers are a starting hypothesis, not a spec.
3. Specific WASM Stockfish package/build to use — bundle size, license,
   NNUE vs. classical eval, and whether a maintained package fits Vite's
   build pipeline cleanly.
4. Tap-to-jump-into-line UX for the 3-line display — confirm intended
   behavior, since the reference screenshot implies it but it wasn't
   explicitly stated.
5. Exact arrow-rendering approach — SVG overlay specifics, viewport-safe
   positioning consistent with existing board rendering.
6. Move-list branching UX when the user deviates from a shown line
   mid-exploration — needs explicit behavior definition, not assumed.

---

## 9. Backlog Placement

Not yet ordered. Spec is complete enough to sit in `docs/specs/` as a
ready-to-scope item. Placement in the active queue (relative to placement
quiz, timed mode, offline PWA, difficulty setting, streak hydration fix,
personal analytics) is a separate decision — this spec does not assume or
claim a position in that order.
