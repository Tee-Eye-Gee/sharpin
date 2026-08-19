# Sharpin — CLAUDE.md

## What this is
Mobile-first chess puzzle trainer. React + Vite 8, fully client-side. Coach layer is local rule-based logic (src/utils/coach.js), not AI.

## Tech stack
- React + Vite 8 (Rolldown/Oxc)
- chess.js + react-chessboard
- Tailwind CSS
- IndexedDB (src/utils/storage.js) — local persistence for guests and as the pre-sync source of truth. Account auth + cross-device sync (backlog #1, Supabase-backed) is in progress — stage 1 of 3 (local schema v3 migration) is done; stages 2-3 (Supabase auth, sync logic) are not built yet. Until stage 2 lands, there is still no backend call on solve/fail.
- Puzzle data: static JSON chunks in src/data/puzzles/, 16 rating-band files

## Environment
- Windows 10, cmd.exe — use `ren`, not `mv` or `Rename-Item`
- `npm run dev` is sufficient for local dev. There are no serverless functions in this app — the `api/` directory, `vercel.json`, and the Claude API dependency were all removed when the coach layer moved client-side. Do not reintroduce a `vercel dev` requirement or any API route unless explicitly asked.
- No API keys, no `.env` file needed.

## Conventions
- Shared labels/constants live in one source-of-truth util (see `src/utils/themeLabels.js`) — don't duplicate strings across components.
- All storage access goes through `src/utils/storage.js` — don't touch IndexedDB directly from components.
- `Board.jsx`'s `handlePieceDrop` (move-commit logic) was recently fixed for an underpromotion bug — the piece-choice argument was being silently discarded. Any change touching move input must call this same function, not fork a parallel path.

## Current task
Account auth & cross-device sync (backlog #1), in progress, stage 1 of 3. Full spec: `docs/specs/Sharpin_Spec_AccountSync.md` — read it in full before writing code. Stage 1 (local IndexedDB schema v3 — hint-used persistence) is done. Stages 2-3 (Supabase auth, sync logic) are not started.

## Explicitly out of scope right now
- Custom "Sharpin" wordmark/logo design — plain styled text only.
- Difficulty setting — backlog item, do not build.
- Click-to-move input rework — separate backlog item, not this task.
