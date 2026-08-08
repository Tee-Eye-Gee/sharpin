# Sharpin — Hint System Spec

Status: Scoped, approved by Tiggs — August 7, 2026. Not yet built. Next in backlog (#1).

## 1. Summary

A new, separate hint control that costs rating when used, distinct from the existing free tactical-lexicon theme-label popover. Binary scoring model — no partial credit for multi-move puzzles. Hint use commits a scoring-fail immediately on first press, independent of whether the puzzle is subsequently finished correctly.

## 2. Two Hints, Two Different Things (do not conflate)

- **Theme label tap** (existing, `tacticalLexicon.js` / `THEME_DEFINITIONS`) — free, score-neutral, no write. Unchanged by this feature.
- **Hint button** (new) — separate UI control. Costs rating on first press. This spec covers this control only.

## 3. Tiering

Two tiers per move, re-armed for every move in the sequence until the puzzle is solved:

- **Tier 1** (first press on a given move): highlights which piece to move.
- **Tier 2** (second press on the same move): highlights the destination square.

Tier resets per move — i.e., moving to the next ply in the sequence re-arms tier 1 for that move.

## 4. Scoring vs. Puzzle-Finish (critical distinction)

Two independent events:

- **Scoring-fail**: committed the instant hint tier 1 is pressed, for the first time, in a given attempt. Rating impact applied immediately (Elo-K24 loss formula, same path as an incorrect move). Puzzle marked not-solved. Theme stats record a miss. This is a single write, gated by the existing attemptCommittedRef / write-once pattern (same reuse point Universal Retry relied on) — a second hint press within the same attempt does not write again.
- **Puzzle-finish**: a UI/interaction state only. Reached when the person makes an incorrect move, OR completes the full correct move sequence. Independent of whether hint was pressed. Board interaction and hint availability persist through to puzzle-finish regardless of hint use.

These do not have to align. A puzzle can score-fail (via hint) and still finish correct (sequence completed properly after the hint).

## 5. No Partial Credit

Binary outcome only. A puzzle is a single-commit unit — there is no per-ply scoring. Getting 2 of 3 moves right and missing the 3rd is a full fail, identical in scoring terms to missing the 1st move. This matches the existing write-gate architecture (one commit per puzzle instance) and deliberately avoids the granularity chess.com's users report as confusing/unfair.

## 6. Give-Up Button — Removed

No give-up control. If the puzzle is loaded, the person is committed to attempting it. (Decided in this session — represents a scope reduction, not an oversight; do not re-add without a new discussion.)

## 7. Button Row States

Row contents by state (replaces/extends the existing showRetryRow logic from Universal Retry):

| State | Row shows |
| --- | --- |
| Initial try (before puzzle-finish) | Hint only |
| Success (puzzle-finish, correct, first attempt) | Retry + Next Puzzle |
| Fail (puzzle-finish, incorrect, first attempt) | Retry + Next Puzzle |
| Follow-up try (after Retry pressed, mid-attempt) | Hint + Next Puzzle |

Notes:
- Follow-up tries never show Retry (retry is already active/consumed; re-triggering it mid-attempt is meaningless).
- Initial try never shows Next Puzzle (no escape before first attempt concludes, since give-up is removed).
- This is a genuinely new row state (4 states, not 2) — Universal Retry only had to handle isFailed/isSolved/isRetrying as a simpler toggle. Hint adds "attempting" as a first-class state with its own row content.

## 8. Retry Interaction

Retry is available on any puzzle outcome at any time — consistent with existing Universal Retry behavior (backlog #2, shipped). No change needed to retry's own write-gate logic. Hint's fail-write is a new call into the same outcome-agnostic gate Universal Retry already proved out; expect this to be the strongest reuse point in implementation, same as it was for Retry.

Hint is available again during a follow-up (retried) attempt — zero-stakes, same as the rest of the retry attempt. A hint press during a retry does not write anything (retry writes are already suppressed by the existing isRetrying skip in onUserMove).

## 9. Status Pill Text

Three states, precise wording:

- **"Solved"** — puzzle finished correctly, no hint pressed at any point during that attempt.
- **"Solved - hint used"** — puzzle finished correctly, but hint was pressed at any point during that attempt (initial try or a retry — attempt-scoped, not retry-scoped).
- **"Not quite"** — puzzle-finish was a fail (wrong move ended the attempt). Applies identically whether or not hint was used before the fail — hint adds no additional information once the outcome is already a fail, so no separate wording is needed for that case.

Explicitly rejected: tying the "hint used" label to "was this a retry" rather than "was hint pressed this attempt" — these are not equivalent (a clean no-hint retry-solve must show plain "Solved"; a hint-then-solve on the *initial* try must show "Solved - hint used").

## 10a. Investigation Findings & Resolutions (Aug 7, 2026)

Claude Code investigated §10 below prior to implementation. Findings and Tiggs' resolutions:

- **finishAttempt split (accepted risk)** — `finishAttempt` currently fuses three things into one call: the commit/write (recordAttempt + rating/streak), the status transition (`solved`/`failed`), and coach-note generation. This fusion is safe for every existing move-triggered path but breaks §4's requirement that a hint press commits the scoring-fail write while leaving the board interactive and status unchanged until actual puzzle-finish. Resolution: `finishAttempt` will be split into (a) a write+coachNote portion, invoked immediately on hint tier-1 press or on a puzzle-finish move, and (b) a status-transition portion, invoked only at actual puzzle-finish (wrong move or completed correct sequence). This is a refactor of shared, already-shipped code (validated by Universal Retry) — regression risk accepted explicitly by Tiggs. Existing move-triggered solve/fail paths must be regression-tested alongside new hint-triggered paths before ship.

- **Coach note timing — fires at write time, not deferred to puzzle-finish.** Coach note generation stays bundled with the write portion above (not the status-transition portion), meaning it fires the instant the scoring-fail commits — same moment as a hint tier-1 press, or same moment as an incorrect move under the old flow. Rationale: if coach note were deferred to puzzle-finish, a user who hints and then bails via Next Puzzle without finishing would never see it. Tying it to the write (which is guaranteed to fire exactly once, per the existing write-once gate) closes that gap. Confirmed this matches current behavior for the existing move-triggered fail path, since the write and status transition are currently simultaneous there — no observable change for non-hint paths.

- **Coach note fires on every fail — to be confirmed, not assumed.** Believed (not yet code-confirmed) that `generateCoachNote` already runs unconditionally on every fail, with early-history users seeing a generic "keep playing, we'll surface a trend" message until enough data exists, then richer notes past that threshold. This existing conditional behavior must survive the finishAttempt split unchanged — flagged for confirmation in the next investigation pass, not treated as assumed-true.

- **Coach note quality is explicitly out of scope.** The coach note content itself (e.g. weak-pattern messaging) is known to be low-value in its current form. This is a separate, future backlog item — not part of Hint System. Do not improve, restructure, or touch coach note *content* logic as part of this feature; only its firing timing (already addressed above) is in scope.

- **Unlimited retries confirmed.** Retry has no cap — a puzzle can be retried indefinitely, including retrying a puzzle that has already been retried and resolved again (a "retry of a retry"). This resolves the previously-unmapped 5th button-row state: a follow-up attempt that itself concludes (solved or failed while isRetrying is true) shows the same row as first-attempt Success/Fail — Retry + Next Puzzle — extending indefinitely for as many retry cycles as the user wants.

## 10. Investigation Items (Step 0) — Status

Per standing investigation-gate practice. Items 1-5 were investigated Aug 7, 2026 (see §10a for resolutions); item 6 is newly added and still open for the next investigation pass.

1. ✅ RESOLVED (§10a) — attemptCommittedRef / finishAttempt write-gate reuse for hint-triggered fail.
2. ✅ RESOLVED — PuzzleControls.jsx row logic scoped to the 4-state table in §7 (extended to unlimited retry per §10a); give-up dead code identified (PuzzleControls.jsx onGiveUp prop + button branch + isActive; usePuzzleEngine.js giveUp callback + export; App.jsx giveUp destructure + prop wiring).
3. ✅ RESOLVED — Per-move tier state lives in usePuzzleEngine.js alongside plyRef, resets on the same move-advance points. Additional scope surfaced: Board.jsx needs new props/logic threaded through for tier 1/2 square highlighting — no existing mechanism for arbitrary highlight beyond lastMove and tap-selection.
4. ✅ RESOLVED — Status pill needs a new attempt-scoped `hintUsedThisAttempt` flag sourced from the hook, resetting only in loadPuzzle (never in retryPuzzle) — matches attemptCommittedRef's own lifecycle, per spec §9's "at any point during that attempt" language.
5. ✅ RESOLVED — isRetrying's existing write-suppression is structurally redundant with the ref-guard for hint's purposes (ref can only be true when isRetrying is true), so no explicit new skip branch is mechanically required; implementer's judgment call on adding one for readability/symmetry.
6. ✅ RESOLVED — Confirmed via code (coach.js:42-67): generateCoachNote fires unconditionally on every commit (no gating), with a generic "keep going, patterns will show up with more attempts" placeholder below the MIN_THEME_SAMPLE (5) threshold, richer weak-theme messaging above it. Matched §10a's assumption exactly; implementation proceeded.

Additional flagged risks from the Aug 7 investigation, not resolved above:

- **Gap B (finishAttempt refactor regression risk)** — accepted by Tiggs, §10a. Requires explicit regression test coverage of untouched move-triggered solve/fail paths alongside new hint-triggered paths.
- **Gap D (no storage schema change)** — confirmed no new field needed in recordAttempt; hintUsedThisAttempt is transient engine/UI state only, not persisted.

## 12. Implementation Status

Implemented and verified Aug 7, 2026 — 41/41 assertions passed across 1280×800 and 320×640 viewports, real DOM + IndexedDB verification, zero console errors, no dead code remaining from give-up removal (confirmed via repo-wide grep). Not yet pushed — held pending §11 (Coach Note Label) being bundled into the same commit. See §11 for the one accepted, explained (not corrected) UX consequence surfaced during verification.

## 11. Addendum — Coach Note Label (Aug 7, 2026, in-scope patch)

Post-implementation, a real UX consequence of §10a's coach-note-timing decision was confirmed in verification: since the coach note fires at write time (first attempt), a hint-then-solved or retried-then-solved puzzle can show a contradictory pair — status pill reads "Solved" or "Solved - hint used" while the coach note still reads fail-flavored text from the first attempt. This is the accepted tradeoff, not a bug — but it reads as inconsistent without explanation.

Decision: this is not corrected (coach-note content/logic remains explicitly out of scope, per §10a), but it is explained. A small, always-visible "Coach Note" label is added, reusing the existing tap-to-define interaction pattern from theme-label chips (same visual treatment, same popover mechanism — no new component type). Tapping the label reveals:

> "Coach notes are generated from your first attempt at this puzzle and don't account for hints or retries."

This single wording covers both edge cases (hint use and retry) in one definition, since a coach note is stale on any first-attempt fail followed by a later clean solve, whether that solve came via hint or plain retry.

Label visibility: **always shown**, not conditionally shown only when a mismatch is present — for consistency, so the affordance doesn't appear/disappear depending on puzzle history.

Scope note: this is a small, deliberate scope addition to the Hint System feature, surfaced explicitly per standing "no scope expansion without surfacing it" practice — not silently folded in. Reuses existing patterns (tacticalLexicon.js / THEME_DEFINITIONS tap-to-define mechanism); no new component category, no coach-note logic changes.
