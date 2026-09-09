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

## Test fixtures
A persistent test account exists in the LIVE Supabase project for Playwright-driven,
real-backend verification across commits — reused instead of creating/deleting a
fresh throwaway account every time, which kept re-tripping `create-account`'s
rate limiter (3/60min per IP) mid-session.

- Profile id: `1e119080-4dd7-46be-a56f-9c54ca46c743`.
- Marked via `display_name = 'TEST_FIXTURE_KEEP'` — the only reliable way to
  identify it in a query. Its auth email is the standard synthetic
  `{uuid}@auth.sharpin.internal`, indistinguishable from any other account by
  that alone.
- Login sequence (the 4 drag-moves matched against its `move_sequence_hash`,
  i.e. its "password"): `[['c2','c4'], ['b2','b4'], ['a1','a2'], ['g1','g2']]`
  (from-square, to-square pairs, in order) on the Login tab's sequence board.
- **Cleanup-check semantics changed.** Every commit's post-test cleanup check
  used to query `select count(*) from public.profiles where id != '<real
  account id>'` and require 0. That will now always show at least 1 (this
  fixture) even when cleanup is otherwise perfect. The query must now exclude
  BOTH the real account id AND this fixture's id, and the result should be
  read as **"0 unexpected test accounts,"** not "0 test accounts." Do not
  delete this fixture as part of a routine cleanup pass — it's meant to
  persist across sessions, unlike every other throwaway test account created
  during verification.
- Its identity (auth user + profile row) is permanent, but its
  `puzzle_attempts`/`profile_stats`/`theme_stats` rows are NOT guaranteed
  stable across test runs — a later verification pass may reset/clear them
  as needed. Don't assume a past commit's test data is still sitting on this
  account.
- Known exception: Commit 6 (guest-to-account migration) specifically tests
  the "brand-new account with zero puzzle_attempts" precondition its
  idempotency pre-check branches on — that test may still need a genuinely
  fresh throwaway account, or this fixture deliberately cleared to zero
  puzzle_attempts first, rather than reusing it in whatever state it's
  accumulated.

## Conventions
- Shared labels/constants live in one source-of-truth util (see `src/utils/themeLabels.js`) — don't duplicate strings across components.
- All storage access goes through `src/utils/storage.js` — don't touch IndexedDB directly from components. Includes `resetAllLocalData()` (atomic reset of all four local stores back to their existing defaults — used by the guest-to-account migration's Discard path; irreversible).
- `Board.jsx`'s `handlePieceDrop` (move-commit logic) was recently fixed for an underpromotion bug — the piece-choice argument was being silently discarded. Any change touching move input must call this same function, not fork a parallel path.
- All Supabase client calls go through the single shared instance exported by `src/lib/supabaseClient.js` — don't call `createClient()` anywhere else.
- The 3-tier launch/auth screen (Guest / Create Account / Login) is `src/components/LaunchOverlay.jsx`, rendered by `App.jsx` only while `sessionStatus === 'none'`. It also owns the guest-to-account migration dialog (Merge/Discard). Its 4-move-sequence input is a temporary placeholder — see "Current task".

## Current task
Account auth & cross-device sync (backlog #1) is **complete for everything currently scoped**, including ongoing sync (six-commit build, September 2026). Full spec: `docs/specs/Sharpin_Spec_AccountSync.md` — §6 has the as-built sync-trigger design. All build stages — local schema v3, the Supabase backend (schema/RLS/Edge Functions, the `recompute_stats()` RPC, sanity-bound CHECK constraints/`anomaly_log`/reconciliation triggers), and the client (session wiring, launch/Login/Create Account UI, guest-to-account migration, ongoing push/pull/recompute sync) — are built, live-verified, and clean.

**Ongoing sync, summarized** (see spec §6 for full detail): push is real-time — after every attempt, direct authenticated client write to `puzzle_attempts`, with a `synced` flag + `remoteId`-keyed retry queue for offline/failed pushes. Pull runs on login and on app foreground/resume (Page Visibility API), watermarked via `puzzle_attempts.updated_at` (not the client-set `attempted_at`). Both triggers run pull → flush → recompute in the background, guarded by a ref-based mutex so the sequence never runs twice concurrently. `profile_stats`/`theme_stats` are written exclusively by the `recompute_stats()` Postgres RPC (`SECURITY INVOKER`, no parameters, derives identity from `auth.uid()`) — never a client-side upsert, including from the guest-to-account migration, which now calls this same RPC instead of computing values itself. A non-blocking, log-only sanity-check backstop (`anomaly_log`) flags — but never rejects — a mismatch between what's written and what `puzzle_attempts` actually supports. No live cross-device conflict resolution is built (sequential device usage assumed, matching the spec's logged accepted risk).

One item remains deliberately deferred, not forgotten — do not assume it's done:
- **The 4-move sequence input is a TEMPORARY PLACEHOLDER**, not the final design: a plain text/token field, hashed client-side via Web Crypto SHA-256. The real input is board-gesture capture (drag/tap out 4 arbitrary moves on a chessboard-style UI, no chess-legality checking) and needs its own dedicated design pass — it's a genuinely new component, not a tweak to the placeholder. Swap boundary: `src/components/LaunchOverlay.jsx`'s `onSequenceComplete(hash)` callback is the entire contract the rest of that file depends on — the real component replaces the placeholder there without touching Login/Create Account logic, App.jsx, or anything else.

No task is currently assigned — awaiting a decision on what's next. Candidates: the sequence-input design pass above, or backlog #2 (Personal Analytics UI) per the original sequencing call logged in the spec (§7).

## Explicitly out of scope right now
- Custom "Sharpin" wordmark/logo design — plain styled text only.
- Difficulty setting — backlog item, do not build.
- Click-to-move input rework — separate backlog item, not this task.
