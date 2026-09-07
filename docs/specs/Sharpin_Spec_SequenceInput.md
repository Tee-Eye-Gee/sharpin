# Sharpin — Sequence Input (Board Gesture) Spec

**Status:** Draft — pending Tiggs review
**Supersedes:** temporary plain-text placeholder in `LaunchOverlay.jsx`
**Swap boundary (unchanged):** `onSequenceComplete(hash)` in `LaunchOverlay.jsx`
**Related:** docs/specs/Sharpin_Spec_AccountSync.md (§5, §5a, §8)

## 1. Purpose

Replace the temporary plain-text sequence field with a real board-gesture
capture: the user defines their 4-move "sequence" by dragging pieces on a
chessboard-style surface. Moves are **not constrained to legal chess
moves** — this is a gesture/pattern input, not a chess move validator.

## 2. Board & Starting Position

- Fixed, deterministic starting position on every attempt (both Create
  Account and Login) so the user can reproduce their chosen sequence:
  **Anderssen vs. Kieseritzky, "The Immortal Game" (1851)**, midpoint
  position — after 11...cxb5, White to move.
  - FEN: `rnb1kb1r/p2p1ppp/5n2/1p3Nq1/4PpP1/3P4/PPP4P/RNBQ1KR1 w kq - 0 12`
- The game title is displayed on the login/launch screen as a caption,
  e.g. "Anderssen vs. Kieseritzky — The Immortal Game (1851)". Purely
  cosmetic/flavor text — does not imply the user must play these
  historical moves.
- Board orientation: standard, White at bottom, regardless of whose turn
  the FEN says it is.

## 3. Interaction Model

- A "move" = drag a piece (any piece, either color, no legality check)
  from an origin square to a destination square.
- Landing on an occupied square **replaces** the occupant (capture-style
  visual) — the displaced piece is removed from the board and not
  restored except via Undo (§4).
- Exactly 4 drags make up the sequence.
- On the 4th drag's completion, the sequence **auto-submits immediately**
  — no confirm/review step.

## 4. Correction — Undo & Reset

- A persistent **Back** button is visible once at least one move has been
  made (moves 1–3; unavailable after the 4th move has auto-submitted).
- Undo restores the **full board state** as of that step — the moved
  piece's prior square **and** any piece it displaced — not merely a
  reverse drag. This requires storing a snapshot (or diff) per move, not
  just the piece's last position.
- A separate **Reset** control is also present alongside Back, returning
  the board directly to the initial Immortal Game midpoint position and
  clearing all moves made so far in the current attempt, regardless of
  how many moves (1–3) have been made.

## 5. Hashing (carries over existing pattern)

- Each move recorded as an origin+destination square pair (UCI-style,
  e.g. `e2e4`).
- The 4 moves are concatenated in order into a single canonical string
  (delimiter TBD during implementation — e.g. `e2e4|g8f6|b5c6|f8b4`).
- That string is hashed client-side via the existing Web Crypto SHA-256
  call, then passed to `onSequenceComplete(hash)` — unchanged from the
  placeholder's contract. No server-side changes required.

## 6. Shared Usage

- Same board component drives both Create Account and Login — identical
  starting position, identical interaction rules. This preserves the
  existing swap-boundary design from Stage 3.

## 7. Explicitly Out of Scope for This Pass

- Visual styling/theming (colors, animation, piece art) — separate
  frontend-design pass.
- Mobile drag ergonomics (touch target sizing at ~375px) — verify live
  during build per standing "real live verification" principle; not a
  design-time decision.
