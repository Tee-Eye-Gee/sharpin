# Sharpin — CLAUDE.md

## What this is
Mobile-first chess puzzle trainer. React + Vite 8, fully client-side. Coach layer is local rule-based logic (src/utils/coach.js), not AI.

## Tech stack
- React + Vite 8 (Rolldown/Oxc)
- chess.js + react-chessboard
- Tailwind CSS
- IndexedDB (src/utils/storage.js, schema v3) — local persistence, and remains the primary/only storage for guests. Every solve/fail still writes here first, unconditionally, regardless of login state.
- Supabase Postgres — live backend for synced accounts (backlog #1, complete for scoped work — see "Current task"). 7 tables, RLS-enforced on all of them (`profiles`, `puzzle_attempts`, `theme_stats`, `profile_stats`, `preferences`, plus rate-limit ledgers `verify_attempts` and `create_account_attempts`). Migrations in `supabase/migrations/`.
- Supabase Auth — identity is a real Supabase Auth user, but reached via a synthetic-email + session-mint pattern (`{profileId}@auth.sharpin.internal`, `generateLink`+`verifyOtp`), not native anonymous auth. Minting logic lives in `supabase/functions/_shared/mint-session.ts`, shared by both Edge Functions below.
- Edge Functions (`supabase/functions/`): `verify-move-sequence` (Login — matches an existing 4-move-sequence hash, mints a session) and `create-account` (creates a new profile + auth user, mints a session). Both are intentionally pre-auth, publicly-callable, and independently rate-limited.
- Client wiring: `src/lib/supabaseClient.js` exports the single shared `supabase` client instance. Solve/fail attempts are NOT pushed to Supabase as they happen — only a one-time historical migration runs, at account creation, if local guest history exists (see "Current task" for what's still deferred).
- Puzzle data: static JSON chunks in src/data/puzzles/, 16 rating-band files

## Environment
- Windows 10, cmd.exe — use `ren`, not `mv` or `Rename-Item`
- `npm run dev` is sufficient for local dev. There are no serverless functions in this app — the `api/` directory, `vercel.json`, and the Claude API dependency were all removed when the coach layer moved client-side. Do not reintroduce a `vercel dev` requirement or any API route unless explicitly asked.
- `.env` is required for the app to boot at all — not optional local-dev setup. Must define `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. `VITE_SUPABASE_URL` must be the **bare** project URL (e.g. `https://<ref>.supabase.co`) — no path suffix. A `/rest/v1` suffix was a real live bug caught this session: it silently broke `supabase.functions.invoke()` and `supabase.auth.setSession()` (wrong base URL), while `getSession()` still appeared to work. `src/lib/supabaseClient.js`'s `createClient()` call throws synchronously if the URL is missing/empty, so a misconfigured or absent `.env` crashes the app on load, not just on some later auth action.

## Conventions
- Shared labels/constants live in one source-of-truth util (see `src/utils/themeLabels.js`) — don't duplicate strings across components.
- All storage access goes through `src/utils/storage.js` — don't touch IndexedDB directly from components. Includes `resetAllLocalData()` (atomic reset of all four local stores back to their existing defaults — used by the guest-to-account migration's Discard path; irreversible).
- `Board.jsx`'s `handlePieceDrop` (move-commit logic) was recently fixed for an underpromotion bug — the piece-choice argument was being silently discarded. Any change touching move input must call this same function, not fork a parallel path.
- All Supabase client calls go through the single shared instance exported by `src/lib/supabaseClient.js` — don't call `createClient()` anywhere else.
- The 3-tier launch/auth screen (Guest / Create Account / Login) is `src/components/LaunchOverlay.jsx`, rendered by `App.jsx` only while `sessionStatus === 'none'`. It also owns the guest-to-account migration dialog (Merge/Discard). Its 4-move-sequence input is a temporary placeholder — see "Current task".

## Current task
Account auth & cross-device sync (backlog #1) is **complete for everything currently scoped**. Full spec: `docs/specs/Sharpin_Spec_AccountSync.md`. All build stages — local schema v3, the Supabase backend (schema/RLS/Edge Functions), and the client (session wiring, launch/Login/Create Account UI, guest-to-account migration) — are built, live-verified, and clean.

Two items are deliberately deferred, not forgotten — do not assume either is done:
- **The 4-move sequence input is a TEMPORARY PLACEHOLDER**, not the final design: a plain text/token field, hashed client-side via Web Crypto SHA-256. The real input is board-gesture capture (drag/tap out 4 arbitrary moves on a chessboard-style UI, no chess-legality checking) and needs its own dedicated design pass — it's a genuinely new component, not a tweak to the placeholder. Swap boundary: `src/components/LaunchOverlay.jsx`'s `onSequenceComplete(hash)` callback is the entire contract the rest of that file depends on — the real component replaces the placeholder there without touching Login/Create Account logic, App.jsx, or anything else.
- **Ongoing sync is not built.** Only a one-time historical migration exists, and only at account-creation time (guest→account Merge/Discard, triggered if local guest history exists at that moment). A logged-in user's puzzle attempts made *after* that point currently only write to local IndexedDB — nothing pushes them to Supabase. Sync-trigger logic (login/logout-boundary push/pull, or any other ongoing trigger) is a separate, unbuilt item.

No task is currently assigned — awaiting a decision on what's next. Candidates: the sequence-input design pass above, ongoing sync, or backlog #2 (Personal Analytics UI) per the original sequencing call logged in the spec (§7).

## Explicitly out of scope right now
- Custom "Sharpin" wordmark/logo design — plain styled text only.
- Difficulty setting — backlog item, do not build.
- Click-to-move input rework — separate backlog item, not this task.
