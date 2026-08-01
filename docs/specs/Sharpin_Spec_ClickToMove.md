# Sharpin — Click-to-Move Input Rework (Spec)

**Backlog item:** #1
**Status:** Scoped, ready to build
**Date scoped:** July 31, 2026
**Depends on:** Existing drag-and-drop commit path (Board.jsx → handlePieceDrop), IndexedDB v2 preferences store, SettingsPanel.jsx

---

## 1. Objective

Add tap-to-move as a second input method alongside existing drag-and-drop. Both methods commit moves through the same function (`handlePieceDrop`) so promotion handling, rating updates, and coach logic stay untouched. Input mode is a persisted user setting, not a hard replacement — user selects tap or drag in Settings, and only the selected mode's handlers are live at any time.

---

## 2. Selection State Machine (tap mode)

| Current state | Action | Result |
| --- | --- | --- |
| No piece selected | Tap own piece | Select it. Show legal destinations. |
| Piece selected | Tap same piece again | Deselect. Clear highlights. |
| Piece selected | Tap a different own piece | Deselect current. **Do not** auto-select the new piece — user must tap it again to select. |
| Piece selected | Tap a highlighted legal destination | Commit move via `handlePieceDrop`. Clear selection/highlights. |
| Piece selected | Tap a non-highlighted (illegal) square | Deselect silently. No error state, no flash. |

No auto-advance, no implicit re-selection anywhere in this flow. Every transition is either "select," "deselect," or "commit."

---

## 3. Visual Language

- **Legal empty-square move:** circle/dot indicator on the square (not a full-square highlight).
- **Legal capture:** highlight/ring around the target piece itself, distinct from the empty-square dot.
- **Selected piece:** existing selection indicator convention (reuse whatever pattern is idiomatic to react-chessboard, or a CSS-variable-backed highlight consistent with current theme tokens).
- All indicator colors must be CSS-variable-backed (RGB-triple tokens per `theme.js`), **not** hardcoded hex, so they render correctly across all 4 board themes and both light/dark app modes. This is a hard requirement, not a nice-to-have — it's the same constraint the July 31 color centralization work just enforced everywhere else.
- Tiggs may supply a visual reference example for circle styling; if not yet provided, use a standard semi-transparent dot centered on the square, sized proportionally (not full-square coverage).

---

## 4. Promotion

No new logic. Tap-to-move's destination-square tap, when it lands on a promotion-eligible move, triggers the same promotion picker UI that drag-and-drop already uses, and passes the user's choice through `handlePieceDrop` exactly as drag does today. This path was already fixed and verified (July 29 underpromotion fix) — tap mode must not fork or duplicate that logic, only reach it via a different trigger.

---

## 5. Input Mode as a Setting

**Storage:**
- IndexedDB v2 `preferences` store gains one new key: `inputMode: "tap" | "drag"`.
- No schema migration required beyond adding the key (v2 already exists; this is not a v3 bump — confirm during build whether adding a key to an existing store requires a version bump in this IndexedDB implementation, or if it can be added in place).
- Default: `"drag"` (preserves current behavior for existing users; no behavior change on upgrade until the user opts in).

**UI:**
- SettingsPanel.jsx (gear icon) gets a second grouped section, distinct from the existing board theme selector — not appended as a stray control. Two clearly separated groups: "Board Theme" and "Piece Movement" (or similar labeling, Tiggs to confirm final copy).

**Behavior:**
- Only one handler set is attached to the board at render time, gated on `inputMode`. Tap handlers and drag handlers are never simultaneously live — this avoids double-fire risk and keeps each mode's state machine isolated.
- Switching the setting takes effect immediately; no reload required.

---

## 6. Mobile Tap Targets

- Tap hit-areas extend beyond the visual square boundary with padding, sized for reliable mobile tapping — visual square size should not be the constraint on tap accuracy.
- Verify on actual mobile viewport widths, not just desktop-narrowed browser windows, given Sharpin's mobile-first requirement.

---

## 7. Explicitly Out of Scope

- No changes to drag-and-drop behavior or its existing handler logic — diff-verify drag path is byte-for-byte unchanged, same discipline as the theming work's Board.jsx diff-verification.
- No changes to rating, streak, or coach logic — this is purely an input-method addition.
- No retry-related logic here (retry is backlog #2, separately decided: unlimited, zero-stakes, user self-advances).
- No hint-system integration here (hint system is backlog #4, separately decided: theme-label-first, piece-highlight-second).

---

## 8. Suggested Commit Split

Consistent with the July 31 pattern (refactor commit, then feature commit):
1. **Commit 1:** Preferences store key addition + SettingsPanel.jsx layout restructure (two sections) — no visible behavior change if default stays `"drag"`.
2. **Commit 2:** Tap-to-move state machine, visual indicators, handler gating logic — the actual feature.

This gives an independent rollback point for the settings/storage plumbing if a bug in the tap logic ever needs isolating from the settings infrastructure.

---

## 9. Open Items for Claude Code to Flag, Not Decide

- Whether IndexedDB v2 → same-v2 key addition needs any version-bump handling in this specific implementation, or is safe to add without one.
- Exact circle/dot sizing and opacity — use reasonable default per §3 unless Tiggs supplies a reference image before build starts.

---

*Sharpin · Spec: Click-to-Move Input Rework · Sterling Axis · July 31, 2026*
