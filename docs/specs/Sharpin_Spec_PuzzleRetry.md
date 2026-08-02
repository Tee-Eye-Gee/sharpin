# Sharpin — Puzzle Retry / Re-Attempt Spec

**Backlog #1 · Sterling Axis · Drafted August 2, 2026**

---

## 0. Investigation Required Before Build (STOP — do this first)

**Confirmed by Tiggs (not to be re-litigated):** the fail penalty already
fires **immediately** on the wrong move — rating/streak/theme-stats commit
at the moment of failure, not on advance. Current UI: puzzle shows a
"Not Quite" message and the puzzle just sits there; a "Next Puzzle"
affordance highlights; the user manually advances. This is existing,
working behavior and **must not change.**

This means the retry feature is additive only — it does not need to move
or gate the existing commit point. Retry just needs to guarantee that
**no further write ever happens** for that puzzle instance, regardless of
how many times the user retries or whether a retry attempt succeeds.

Claude Code must still investigate and report back before writing any
retry logic — the unknowns are mechanical, not about timing:

1. Where exactly does the existing fail-commit happen in `onUserMove` /
   `finishAttempt` (`usePuzzleEngine.js`)? Confirm this is a single write,
   not something that could double-fire if the puzzle is re-evaluated.
2. After that commit fires, what is the current puzzle-object/board state?
   Does anything reset automatically, or does the board stay exactly as
   the user left it (per the "just sits there" description)?
3. Is there an existing distinct flag/state for "this puzzle has already
   been marked failed" that a retry-then-resolve path can check against —
   or does one need to be added to guarantee no second write is possible?
4. Confirm coach.js reads from the same single write — no separate stat
   update elsewhere that also needs gating.

**Report findings before proceeding to §2.** If there is any code path
where a second commit could fire after retry (e.g. `onUserMove` re-running
its full commit logic on a post-retry move with no "already failed" guard),
that guard must be added as part of this build — flag it explicitly rather
than assuming it's already safe.

---

## 1. Decided Requirements (per Master Context §5, §11, refined with
Tiggs Aug 2 — not open for re-litigation)

- Fail is penalized **immediately and exactly once**, on the original wrong
  move — existing behavior, unchanged by this feature.
- After that single penalty, the user can **retry unlimited times** — board
  resets to puzzle start, same puzzle ID.
- **Zero additional stakes on any retry** — no further rating delta, streak
  impact, or theme-stat (coach.js) write, whether a retry attempt fails
  again or succeeds.
- A **solve after retry does not count as a correct solve** for rating/
  streak/theme-stats — the puzzle's outcome for scoring purposes was
  already fixed at the original fail.
- **User self-selects** when to advance to the next puzzle (whether they
  retried or not). No auto-advance.
- **No retry-counter state** — do not add a `retryCount` field or similar.
- Need some UI signal during a failed retry attempt (e.g. "still not right,
  try again") — exact treatment TBD in §3, could be as simple as the
  existing "Not Quite" message reappearing plus the Retry button
  re-highlighting.
- Rationale (§6, Master Context): a same-session retry-after-seeing-the-
  puzzle-fail is not a genuine solve signal. Counting it would poison
  coach.js's weak-pattern detection, which compares last-10-attempt solve
  rate per theme against overall solve rate.

## 2. Behavior Spec

| Current State | Action | Result |
| --- | --- | --- |
| Puzzle in progress (first attempt) | User makes wrong move | **Existing behavior, unchanged:** rating/streak/theme-stats penalty commits immediately, once. "Not Quite" message shown. "Next Puzzle" affordance highlights. |
| Puzzle failed | User clicks "Retry" | Board resets to puzzle start position. Same puzzle ID. **No write of any kind** — this puzzle's outcome is already fixed as a fail from the original commit. |
| Puzzle in progress (post-retry) | User makes wrong move again | Shows a "still not right" signal (see §3) and re-offers Retry. **No additional write** — already-committed fail stands. |
| Puzzle in progress (post-retry) | User solves correctly | Board shows solved state for the user's own satisfaction/practice, **but no rating/streak/theme-stat write** — the puzzle already counted as a fail. |
| Puzzle failed or post-retry-solved | User clicks "Next Puzzle" | Advance to a new puzzle. Fresh puzzle instance, counter/state starts clean. |
| Puzzle in progress | User solves correctly on first try (no prior fail) | Existing behavior — unchanged. Counts as a genuine solve. |

**Key implementation implication:** because the penalty already committed
on the original fail, the retry path must be purely presentational (board
reset) with a hard guarantee against any second write — not a "decide what
to commit and when" mechanism. See §0 for the guard-check investigation.

## 3. UI Requirements

- On original fail: existing "Not Quite" message and "Next Puzzle"
  highlight stay as-is. **Add** a "Retry" affordance alongside "Next
  Puzzle" — both available simultaneously, no forced order.
- On a wrong move during a retry attempt: some signal that this attempt
  also isn't right and the user needs to start over — simplest option is
  reusing the existing "Not Quite" message plus re-highlighting Retry.
  Claude Code can propose the minimal-diff option here rather than
  inventing new UI language, but should confirm exact current messaging/
  component reuse against §0 findings first.
- Visual treatment should reuse existing theme-token system
  (`theme.js` / CSS-variable tokens) — no hardcoded colors, consistent with
  all prior UI work (theming, PromotionPicker).
- No modal/dialog unless the existing fail-state UI already uses one —
  confirm in §0 investigation rather than assuming.

## 4. Explicitly Out of Scope

- No retry-counter UI ("2nd attempt", etc.) — decided against in Master
  Context §5.
- No difference in coaching behavior between a first-try solve and a
  post-retry solve, beyond the stat-recording rule in §2 — coach.js logic
  itself is untouched.
- No changes to puzzle selection/weighting logic.

## 5. Verification Standard (per project convention — real interaction, not
just build success)

Before calling this done, confirm via actual DOM interaction:

1. Fail a puzzle → confirm exactly one rating/streak/theme-stat write
   occurs, immediately, matching existing pre-feature behavior — check via
   storage inspection, not assumption.
2. Retry → confirm board resets to puzzle start, same puzzle ID, unlimited
   times, with **zero** additional writes on each retry attempt (fail or
   solve) — verify via storage inspection after each retry, not just the
   first.
3. Retry repeatedly failing (3+ times) → confirm the original single fail
   write still stands and no duplicate/cumulative penalty was applied.
4. Retry, then solve → confirm this does **not** get recorded as a fresh
   correct solve — rating/streak/theme-stats must reflect only the original
   fail.
5. Click "Next Puzzle" (with or without having retried) → confirm a
   genuinely new puzzle instance loads with clean state.
6. Solve correctly on first try (no fail, no retry) → confirm existing
   behavior is byte-for-byte unchanged — counts as a genuine solve, single
   write, as before.
7. Confirm zero network calls fire on any of the above (project's
   no-external-call constraint) — via captured request logs, per existing
   coach.js verification standard.

---

*Sharpin · Puzzle Retry Spec · Sterling Axis · August 2, 2026*
