# Sharpin — Spec: Universal Retry + Explicit Solve Confirmation

**Backlog item:** #2 (Universal Retry + Explicit Solve Confirmation)
**Status:** Scoped, ready for build
**Date:** August 5, 2026

## 1. Problem

Puzzle Retry (shipped Aug 2) only made retry available after an incorrect move. Live production testing surfaced two gaps:

1. No dedicated visual confirmation on a correct solve — success wasn't distinct enough from other puzzle states.
2. Retry was unavailable after a correct solve — no way to re-attempt/replay a puzzle you already passed.

## 2. Behavior

### 2.1 Universal retry availability
- Retry is available after **any** solve outcome — correct or incorrect — using the existing retry mechanism built for Puzzle Retry.
- Retry is **navigation-boxed**: available until "Next Puzzle" is pressed. Once the user advances, retry into the prior puzzle is no longer available.

### 2.2 Stakes model
- Only the **first attempt** on a given puzzle affects rating, streak, and theme stats.
- Every retry — regardless of whether the original attempt was correct or incorrect — is zero-stakes. No further effect on rating/streak/stats, no matter how many times retried.

### 2.3 Success indicator
- On a correct solve (first-try or post-retry), show an explicit inline confirmation — checkmark + "Solved" state.
- Location: existing theme-chip/status region (not a new modal or toast). Reuses existing token system — no new colors introduced.

## 3. Reuse (from Puzzle Retry, shipped Aug 2)

- `attemptCommittedRef` guard
- `isRetrying` UI flag
- `retryPuzzle()` function

This feature extends that mechanism to fire on correct solves too, rather than only on incorrect ones. No new retry engine required.

## 4. Out of scope

- Any change to rating/streak/stat calculation logic — the zero-stakes retry model from Puzzle Retry carries forward unchanged, just extended to correct-solve retries.
- Puzzle archive/review-by-outcome grouping (passed first-time / passed on retry / still unsolved) — logged as a separate, not-yet-scoped backlog idea. Not part of this build.

## 5. Open items for Claude Code to flag if encountered

- Confirm `attemptCommittedRef` cleanly supports being triggered from a correct-solve state, not just a fail state — if the guard's current logic assumes fail-only, flag before extending it blind.
- Confirm the theme-chip/status region has room for a success state without layout shift on mobile — if it doesn't, stop and flag rather than guessing a fix.

## 6. Verification requirements

- Real DOM interaction (not just visual inspection): confirm retry button/control is present and functional after both correct and incorrect solves, and absent after "Next Puzzle" is pressed.
- Confirm via storage inspection that only the first attempt writes to rating/streak/stats, and that repeated retries — regardless of correct/incorrect — do not write additional stat changes.
- Live on-device smoke test on mobile before logging complete, per standing project practice.
