# Sharpin — CLAUDE.md

## What this is
Mobile-first chess puzzle trainer. React + Vite 8, fully client-side. Coach layer is local rule-based logic (src/utils/coach.js), not AI.

## Tech stack
- React + Vite 8 (Rolldown/Oxc)
- chess.js + react-chessboard
- Tailwind CSS
- IndexedDB (src/utils/storage.js, schema v3) — local persistence, and remains the primary/only storage for guests. Every solve/fail still writes here first, unconditionally, regardless of login state. **Namespaced by identity** (storage-partitioning build, September 2026 — see "Current task"): every store is keyed/tagged by a real account's id when logged in, or the fixed `GUEST_IDENTITY` (`'guest'`) sentinel otherwise, closing a cross-account local-storage leak the ongoing-sync build above didn't originally account for. `adoptLegacyDataIfSafe()` migrates any pre-partitioning local data into the correct namespace, once, on first boot.
- Supabase Postgres — live backend for synced accounts. Production project `wrexmksxphqkanrzzvcd` is the **only** project (dev points at it too). 6 tables, RLS-enforced on all of them (`profiles`, `puzzle_attempts`, `theme_stats`, `profile_stats`, `preferences`, `anomaly_log`). The V1 rate-limit ledgers `verify_attempts`/`create_account_attempts` and `profiles.move_sequence_hash` were dropped by the Auth V2 migration (2026-10-09). Migrations in `supabase/migrations/`.
- Supabase Auth — **Auth V2 (in progress, see "Auth V2" below):** email identifies the account; the password is the lowercase hex SHA-256 of the 4 board-drawn moves joined with `|` (Supabase bcrypts it again). Native `signUp`/`signInWithPassword`/`resetPasswordForEmail`/`updateUser`. A `profiles` row is created by the `on_auth_user_created` trigger (`handle_new_user()`, inserts `(id)` only). *Historical (V1, retired 2026-10-09):* the sequence hash was the only credential, matched by the `verify-move-sequence` Edge Function, which minted sessions for synthetic `{profileId}@auth.sharpin.internal` users via `_shared/mint-session.ts`; `create-account` created them. Both functions are undeployed and their source deleted (`c2e54d7`). The two existing accounts still carry synthetic emails until Auth V2 step 5 migrates them.
- Edge Functions (`supabase/functions/`): `update-profile` (display-name update, authenticated) and `_shared/validate-display-name.ts`. A `delete-account` function (service role) is planned for Auth V2.
- Client wiring: `src/lib/supabaseClient.js` exports the single shared `supabase` client instance. Attempts push to Supabase in real time while logged in, with a retry queue; see "Ongoing sync, summarized".
- Puzzle data: static JSON chunks in src/data/puzzles/, 16 rating-band files

## Environment
- Windows 10, cmd.exe — use `ren`, not `mv` or `Rename-Item`
- `npm run dev` is sufficient for local dev. There are no serverless functions in this app — the `api/` directory, `vercel.json`, and the Claude API dependency were all removed when the coach layer moved client-side. Do not reintroduce a `vercel dev` requirement or any API route unless explicitly asked.
- `.env` is required for the app to boot at all — not optional local-dev setup. Must define `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. `VITE_SUPABASE_URL` must be the **bare** project URL (e.g. `https://<ref>.supabase.co`) — no path suffix. A `/rest/v1` suffix was a real live bug caught this session: it silently broke `supabase.functions.invoke()` and `supabase.auth.setSession()` (wrong base URL), while `getSession()` still appeared to work. `src/lib/supabaseClient.js`'s `createClient()` call throws synchronously if the URL is missing/empty, so a misconfigured or absent `.env` crashes the app on load, not just on some later auth action.
- **Production URL: https://sharpin-your-game.vercel.app** (Vercel-assigned; no custom domain yet). `sharpin-ten.vercel.app` and `sharpinurgame.vercel.app` only 307-redirect to it. The GitHub repo homepage field points at it (updated 2026-10-10). If a custom domain is added later, the Supabase Site URL, Redirect URLs, and `ALLOWED_ORIGINS` must all be updated together.
- **`ALLOWED_ORIGINS` (Edge Function secret) = `https://sharpin-your-game.vercel.app`**, verified 2026-10-10 by SHA-256 digest match (`supabase secrets list` prints digests, not values). Format, per `update-profile/index.ts:37-48`: comma-separated, each entry an exact origin with scheme, no trailing slash or path; matched by exact string equality against the browser's `Origin` header. `http://localhost:<port>` is allowed separately by a regex and needs no entry.
- **Backups:** `backups/2026-10-09-pre-auth-v2/` (gitignored). JSON per table of `profiles`, `puzzle_attempts`, `theme_stats`, `profile_stats`, `preferences`, `anomaly_log`, plus `auth.users` (id, email, created_at), taken before the Auth V2 migration. Row counts verified: 2/25/40/2/2/0/2. `profiles.json` contains the retired V1 `move_sequence_hash` values; never commit this directory.

## Test fixtures
A persistent test account exists in the LIVE Supabase project for Playwright-driven,
real-backend verification across commits — reused instead of creating/deleting a
fresh throwaway account every time, which kept re-tripping `create-account`'s
rate limiter (3/60min per IP) mid-session.

- Profile id: `1e119080-4dd7-46be-a56f-9c54ca46c743`.
- **Current state (2026-10-10): 2 attempts, rating 1175, 0 solved / 2 failed**
  (from the #1d live check). **It cannot sign in right now:** V1 login was
  retired with Auth V2 step 1, and the fixture only becomes usable again once
  Auth V2 step 5 gives it a controlled email and sets its existing hash as its
  Supabase password (spec D8).
- Marked via `display_name = 'TEST_FIXTURE_KEEP'` — the only reliable way to
  identify it in a query. Its auth email is still the V1 synthetic
  `{uuid}@auth.sharpin.internal` until that migration.
- Sequence: `[['c2','c4'], ['b2','b4'], ['a1','a2'], ['g1','g2']]`
  (from-square, to-square pairs, in order). Under V1 its hash was matched
  against `move_sequence_hash`; under Auth V2 the same hash becomes its
  password.
- **The other real account: Tee_Eye_Gee = `43d53ce6-67e9-4417-bdbc-5898065018d2`**
  (Tiggs's own, 23 attempts, rating 1215, 10 solved / 13 failed). Not a
  fixture — never reset its data. Not to be confused with the deleted
  `Tee_Eye_Gee_Test_1` (`be6c5c2e…`). Migrated in place in Auth V2 step 5 (D8).
- **Throwaway accounts under Auth V2 (D16):** plus-addressed Gmail
  (`horacetiggsiv+<tag>@gmail.com`) for the real confirmation flow, or
  dashboard "Add user" with Auto Confirm for quick checks.
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
- All storage access goes through `src/utils/storage.js` — don't touch IndexedDB directly from components. Includes `resetAllLocalData({ identity })` (reset of **one identity's** data across all four local stores back to defaults — a per-identity cursor-based delete, not a wholesale store `.clear()`, since a device can legitimately hold more than one identity's data side by side post-partitioning; used by the guest-to-account migration's Discard path, always called with `{ identity: GUEST_IDENTITY }` explicitly; irreversible).
- `Board.jsx`'s `handlePieceDrop` (move-commit logic) was recently fixed for an underpromotion bug — the piece-choice argument was being silently discarded. Any change touching move input must call this same function, not fork a parallel path.
- All Supabase client calls go through the single shared instance exported by `src/lib/supabaseClient.js` — don't call `createClient()` anywhere else.
- The 3-tier launch/auth screen (Guest / Create Account / Login) is `src/components/LaunchOverlay.jsx`, rendered by `App.jsx` only while `sessionStatus === 'none'`. It also owns the guest-to-account migration dialog (Merge/Discard). Its sequence input is `SequenceBoardInput.jsx` (board gestures). **Its Login/Create Account handlers still call the undeployed V1 functions**, so dev login and account creation fail until the Auth V2 client UI step replaces them.

## Technical learnings
- **Mocked test suites can undercount real SDK-internal calls tied to auth-header attachment.**
  Discovered live-verifying #1e/#1f (2026-09-14): `syncPreferences`'s pull-branch retry path was
  asserted at exactly 4 `getSession()` calls (2 attempts × 2 calls each) against the local mocked
  test suite, and that assertion passed. Against the REAL `@supabase/supabase-js` client it was 5
  — the SDK itself makes its own internal `getSession()` call (`SupabaseClient._getSessionToken`)
  to attach the current access token's Authorization header whenever an authenticated REST call
  actually fires. The mocked tests never see this, because their mocked `.from(...)` never calls
  `getSession()` at all — only the code under test's own explicit calls get counted. **A
  call-count assertion carried over unchanged from a mock to a live run is not a safe assumption —
  derive the expected count from what a live, instrumented run actually logs, not from what the
  mock happened to require.** This is not a bug in the code under test; it's a fidelity gap
  specific to *this kind* of assertion (counting calls to a method the SDK itself also calls
  internally) — most other assertion styles (did the right row land, under which identity,
  server-side) don't have this gap and transfer from mock to live verification directly.
- **Open, deliberately unresolved: a libuv assertion crash** (`Assertion failed:
  !(handle->flags & UV_HANDLE_CLOSING)`) hit once, in a one-off, since-deleted live-verification
  scratch script, immediately after a `process.exit(1)` call following an `await fetch(...)`. The
  likely mechanism (`fetch`'s own handle mid-teardown colliding with an abrupt `process.exit()`)
  and the applied fix (`process.exitCode` instead) were **never actually verified against a
  recurrence** — the retry that "confirmed" it fixed ran under different conditions (the rate
  limit had cleared, so it took the success branch, which never called `process.exit()` even in
  the original script) and simply never re-exercised the failing branch. Left unresolved on
  purpose, not silently treated as fixed: the script no longer exists and has no production code
  path, and its only output (diagnostic console logs) was independently confirmed reliable — fully
  printed before the crash in every case it happened — so nothing about this affected the
  trustworthiness of any verification result. If this exact crash resurfaces in a future
  live-verification script, treat it as unexplained, not as "the known, already-fixed one."
- **npm's default log retention (`logs-max`) is shallow enough that a forensic/artifact-trail question
  may not be answerable more than a few days after the fact** — confirmed during the artifact-trail
  integrity audit (2026-09-20), where no npm install log survived from a relevant date only 6 days
  prior. Worth knowing before relying on npm logs as evidence in the future; this machine's
  `logs-max` was raised to 50 the same day specifically to give future questions more depth to check
  against.
- **`supabase db query --linked` is not a pure read — flag it before use.** It prints "Initialising
  login role..." and sets up a temporary login role on the production project via the Management
  API before running even a plain SELECT. Since production is the only project, say so before
  running it, even for read-only checks (learned 2026-10-09).
- **Always put raw evidence in one message.** Evidence split across messages or summarized
  ("full output above") gets lost when chat output is truncated or pasted elsewhere. When raw
  output is requested, paste it in full, in the same message as the conclusion it supports.
- **Line endings: `git rebase --autostash` rewrote an uncommitted LF file as CRLF** (2026-10-09). Text
  content was unchanged and `git diff` looked identical, but bytes differed. Back up uncommitted
  files before autostashing, and compare bytes (`cmp`, CR count), not just line counts.

## Current task
Account auth & cross-device sync (backlog #1) is **complete for everything currently scoped**, including ongoing sync (six-commit build, September 2026). Full spec: `docs/specs/Sharpin_Spec_AccountSync.md` — §6 has the as-built sync-trigger design. All build stages — local schema v3, the Supabase backend (schema/RLS/Edge Functions, the `recompute_stats()` RPC, sanity-bound CHECK constraints/`anomaly_log`/reconciliation triggers), and the client (session wiring, launch/Login/Create Account UI, guest-to-account migration, ongoing push/pull/recompute sync) — are built, live-verified, and clean **as of that build**. The storage-partitioning build below (September 2026, separate from and after the six-commit build) touches some of this same client code (`LaunchOverlay.jsx`, `App.jsx`) but has only been verified locally (fake-indexeddb, jsdom, a crafted real-`@supabase/supabase-js` fixture) — not against the live Supabase project. Don't read "live-verified" above as still describing the current state of that touched code. **Backlog #1g (below) found and closed a real correctness gap in this same backlog item, live-verified 2026-09-14**: an account's rating/streak/theme-accuracy used to silently reset to defaults on any device without local history for that identity (not just at the guest-to-account Merge boundary) — fixed by `pullProfileStats()`, see that section for the full build.

**Ongoing sync, summarized** (see spec §6 for full detail): push is real-time — after every attempt, direct authenticated client write to `puzzle_attempts`, with a `synced` flag + `remoteId`-keyed retry queue for offline/failed pushes. Pull runs on login and on app foreground/resume (Page Visibility API), watermarked via `puzzle_attempts.updated_at` (not the client-set `attempted_at`). Both triggers run pull → flush → recompute in the background, guarded by a ref-based mutex so the sequence never runs twice concurrently. `profile_stats`/`theme_stats` are written exclusively by the `recompute_stats()` Postgres RPC (`SECURITY INVOKER`, no parameters, derives identity from `auth.uid()`) — never a client-side upsert, including from the guest-to-account migration, which now calls this same RPC instead of computing values itself. A non-blocking, log-only sanity-check backstop (`anomaly_log`) flags — but never rejects — a mismatch between what's written and what `puzzle_attempts` actually supports. No live cross-device conflict resolution is built (sequential device usage assumed, matching the spec's logged accepted risk). Theme/preferences sync (below) extends this same push/pull pattern to the single-row `preferences` table.

*Historical:* the text-field sequence placeholder this section used to describe has since been replaced by `SequenceBoardInput.jsx` (board-gesture capture, `onSequenceComplete(hash)`), and the V1 credential model it fed is being replaced by Auth V2 (below).

### Storage partitioning (September 2026, 4-commit build)

Full investigation: `docs/specs/storage-partitioning-investigation.md` (original
findings plus four addenda). Fixes a cross-account local-storage leak: before
this build, all four local stores (`profile`, `attempts`, `themeStats`,
`preferences`) were keyed identically regardless of who was using the device,
so a second identity (a different account, or a guest) on the same device
could inherit or push a previous identity's data — the guest-to-account
migration's Merge path was the sharpest version of this. Commits 1-3 of 4 are
done; this section **is** Commit 4.

**Namespacing model** (Commit 1, `src/utils/storage.js`): `resolveIdentity()`
calls `supabase.auth.getSession()` (gated behind `ACCOUNT_SYNC_ENABLED`
first, so "flag off means zero Supabase traffic" holds literally) and
resolves to either a real account id or `GUEST_IDENTITY`. `profile`/
`preferences` are keyed directly by identity; `attempts` rows carry an
`ownerId` field (filtered by strict equality — a record with no `ownerId` at
all stays invisible everywhere until adopted, never guessed at); `themeStats`
uses a compound `` `${identity}::${theme}` `` key. No `DB_VERSION` bump —
purely an application-level key-scheme change. `getAllAttempts`/
`getPreferences`/`resetAllLocalData`/`markAttemptsSynced` accept an optional
explicit `identity` override for `LaunchOverlay.jsx`'s guest-to-account
migration path (Commit 2), which needs to target `GUEST_IDENTITY`
specifically regardless of whichever account session is already active by
the time Merge/Discard runs — auto-resolution alone is wrong there by
construction, not just insufficiently defensive.

**First-boot adoption routine** (Commit 3, `adoptLegacyDataIfSafe(identity)`):
migrates any data still sitting under the pre-partitioning bare keys/tags
into the given identity's namespace.
- **Idempotency**: no separate "done" flag. Presence/absence of legacy,
  un-namespaced data is the signal — once adopted (copied to the new key/tag,
  old bare key/tag deleted, same transaction), there's nothing left for a
  later call to find. Safe and cheap to call on every boot forever.
- **Deferred-confirmation logic**: takes an already-resolved `identity`, never
  calls `getSession()` itself, and must never be called while `App.jsx`'s own
  boot-time session resolution is still in flight (`sessionStatus ===
  'checking'`) — there is no third "unconfirmed" value, only a real account
  id or `GUEST_IDENTITY`. `App.jsx`'s boot effect was restructured from three
  independent effects into one ordered sequence (resolve session → adopt →
  load preferences) specifically so adoption always completes before any
  other identity-scoped read this boot.
- **Guest-vs-stranded-account disambiguation**: a resolved "no session" is
  NOT automatically safe to treat as a genuine guest — a real account's
  session can die between boots (refresh fails, access token's real expiry
  has passed) and also resolves to a clean "no session," indistinguishable by
  session state alone. Resolved by checking the RAW, pre-`withSyncedDefault`
  stored `synced` value on legacy attempts rows: `synced === true` can only
  ever have been set by a session-gated write (confirmed clean via full code
  + git-history trace — no guest-reachable path produces it), so its presence
  defers adoption entirely rather than guessing; its absence proceeds
  immediately as a genuine guest.

**Forward dependency — RESOLVED (2026-09-14): re-verified now that Logout
(backlog #2) actually shipped, not still an open future task.** This note
originally said the guest-vs-stranded-account disambiguation above, and the
"no session ever existed" reasoning generally, relied on logout not
existing yet, and that a real `supabase.auth.signOut()` call would need to
reopen this. That call now exists (`App.jsx`'s `handleLogout`) — see the
Logout section below for the full build. **Re-checked against the actual
shipped mechanism, per that section's own Gate Step 0: `adoptLegacyDataIfSafe`
is only ever called from `App.jsx`'s boot effect, which fires exactly once
per real page mount and cannot be re-triggered by logout (an in-memory SPA
state reset, not a remount — confirmed concretely against `main.jsx`, see
Gate Step 0 below).** A device going guest → account → logout → guest
again within one tab therefore never re-runs the adoption routine at all
during that session — the one-shot, presence-based idempotency this note
was worried about is untouched, because logout structurally cannot reach
the code path that idempotency protects. Nothing here needed to change as
a result of Logout shipping.

**✅ RESOLVED 2026-10-09 by `a8a7b37` (#1d, see "Backlog #1d" below). The
original blocking note is kept for history:** ~~do not enable
`VITE_ENABLE_ACCOUNT_SYNC` for any account with pre-existing local legacy
history until this is fixed:~~
`usePuzzleEngine`'s own `loadPuzzle` effect is *guaranteed* to run before
`App.jsx`'s boot effect even starts (`usePuzzleEngine()` is called before
`App`'s own `useEffect`s are registered, and React fires passive effects in
registration order) — not a narrow race, a deterministic ordering on every
mount. On any device with legacy local history, this means the first puzzle
is always selected from the wrong (still-defaulted) rating band, and
committing it can permanently corrupt the persisted profile: `commitAttempt`
computes `newRating`/`delta` from the stale profile, then `recordAttempt`'s
own separate profile read may land on either side of adoption's write — if
after, it silently reverts the just-recorded profile update; if before, the
totals are right but the rating field still carries the wrong value. Either
way the wrong `ratingDelta` lands on the attempt row and, if a real session
is active, gets pushed to `puzzle_attempts` and folded permanently into
`recompute_stats()`'s summed rating server-side — **no correction path
exists for a bad historical `rating_delta` once it's there.** This is a
required fix, not backlog — traced in detail in Commit 3's commit message
(`git log`), not yet fixed, touches `usePuzzleEngine.js` (outside the
4-commit build's stated scope).

### Theme/preferences sync (September 2026, 5-commit build)

Full investigation: `docs/specs/theme-preferences-sync-investigation.md`
(original findings plus a follow-up addendum tracing the push-in-flight /
foreground-pull race). Extends the same ongoing-sync pattern already shipped
for `puzzle_attempts` (see "Ongoing sync, summarized" above) to the
single-row `preferences` table — board theme, app mode, input mode. Commits
1-3 of 5 are done; Commit 4 was explicitly skipped (see below); this section
**is** Commit 5.

**Push + pull** (Commits 1-2, `src/utils/storage.js`): `updatePreferences`
writes locally with `synced: false` immediately, then fires an unawaited
`pushPreferencesIfPossible` — a direct authenticated upsert against
`preferences`, flipping `synced: true` only after a confirmed success
response, never speculatively. `syncPreferences` (the same foreground/resume
and login triggers attempts already uses) is a **mutually exclusive**
push-if-unsynced/else-pull-if-newer branch — deliberately NOT attempts' own
pull-then-push order, because `preferences` is a single mutable row, not an
append-only log: letting a pull run at the same time as a retry push could
silently clobber a genuinely-pending local edit. The pull branch compares
the server row's `updated_at` against this device's own
`preferencesUpdatedAt` specifically — never `lastPulledAt`, which is
attempts' own, unrelated watermark.

**Out-of-order-response guard** (Commit 3, `pendingToken` on
`pushPreferencesIfPossible`): closes a distinct race traced in the
investigation's addendum — two fire-and-forget pushes (for two different
edits, or the same edit retried from both `updatePreferences`' click path
and `syncPreferences`' foreground-retry path) can have their success
responses arrive out of order. Every local write generates a fresh
`pendingToken`; before flipping `synced: true`, the push re-reads the record
fresh and only confirms if its own `pendingToken` still matches the one that
push was for — a stale response for a superseded edit can never mark a
newer, still-unconfirmed edit as synced. Proven in
`src/utils/storage.preferencesOutOfOrder.test.js` against both the
two-edits-racing-each-other case and the two-call-paths-racing-the-same-edit
case, including a negative control (guard temporarily disabled in-session,
confirmed the relevant tests then fail, then restored).

**Commit 4 (optional redundant-push guard): explicitly skipped, not built.**
The `preferences` upsert is already idempotent and server-`updated_at`-ordered,
so a redundant concurrent push (e.g. the click path and the foreground-retry
path both firing for the same still-unsynced edit) is harmless today, only
wasteful. A clean in-flight guard would need to skip the second call
entirely once one is already outstanding for a given `pendingToken` — but
that is exactly the scenario Commit 3's own test suite
(`storage.preferencesOutOfOrder.test.js`) was built to exercise (both paths'
pushes genuinely in flight at once, neither treating the other's response as
stale). Building it would silently invalidate that already-committed test's
premise rather than sit cleanly on top of it, so it was left out per this
build's own "skip rather than force it" instruction. Not a correctness gap —
a pure efficiency optimization left on the table, safe to pick up later in
isolation if it matters.

**Backlog status.** Per the investigation's Verification Plan (§5): the
actual backlog claim — **cross-device** board theme/preference inheritance —
is **closed, live-verified against the real Supabase project** (2026-09-12)
via **two independent Login sessions on the same account** (no browser
automation exists in this repo, so this used two separate, independently-
minted calls to the deployed `verify-move-sequence` Edge Function rather
than two literal browser contexts — the accepted substitute for this
specific claim). Session A called the real `updatePreferences` code path
against the live `preferences` table (TEST_FIXTURE_KEEP,
`1e119080-4dd7-46be-a56f-9c54ca46c743`) to set `board_theme: 'wood'`, and
confirmed a synced response; Session B — independently logged in, with its
local state explicitly reset first so it genuinely started as "a device
that never locally selected a theme" — called the real `syncPreferences`
pull path and correctly received `board_theme: 'wood'`. Only the transport
was substituted (a live `@supabase/supabase-js` client injected in place of
vitest.config.js's fixture URL/key), never the app's own
`updatePreferences`/`syncPreferences` functions or query shapes — this
proves the actual code path, not just hand-written equivalent SQL. The
one-off verification script was deleted after running (not part of the
committed suite — it hits real network and a real account, unsuitable for
regular/CI runs); TEST_FIXTURE_KEEP had no pre-existing `preferences` row
before this check, so the row this test created was deleted afterward
(verified empty again), restoring the exact pre-test state rather than
leaving `'wood'` behind as an undocumented side effect. This did NOT
require logout to exist at all, since it uses Login (already shipped)
rather than a single-context logout→relogin cycle. What remains open, and
is explicitly out of scope here, is narrower: **the same-device
logout→relogin round trip** specifically — confirming a device's own
preferences survive its own logout/login boundary intact. That is a
logout-correctness question, not a cross-device-sync question, and stays
blocked until Logout (backlog #2) is built; tracked there, not here.
Local-only mechanism tests (mocked Supabase client) remain in the
committed suite: `src/utils/storage.preferencesPush.test.js`,
`storage.preferencesSync.test.js`, `storage.preferencesOutOfOrder.test.js`.

### Identity-pinned sync guards (September 2026, 2-commit build, Backlog #1e/#1f)

Full investigations: `docs/specs/identity-pinned-push-guard-investigation.md`
(#1e) and `docs/specs/pull-side-identity-race-investigation.md` (#1f), both
surfaced as byproducts of scoping Logout (backlog #2) — logging out would be
the first code path able to change which identity is live within a single
page load, and neither sync system's fire-and-forget push/pull functions
were built to survive that. **Both commits are built, locally tested, and
now live-verified against the production Supabase project (2026-09-14) —
closed. Neither is a blocking precondition on Logout (#2) anymore.**

**Commit 1/2 — push-side identity-pinned guards (#1e):** `pushAttemptIfPossible`
and `pushPreferencesIfPossible` both re-resolved "whose data is this" from
the live session at execution time, not the identity active when the write
was queued — a same-page-load identity switch (once Logout exists) could
land an in-flight push under the wrong account. Fixed with a one-line guard
in each, comparing the freshly-resolved session against a value already
available (`attempt.ownerId`, pinned at record time; the `identity`
parameter `pushPreferencesIfPossible` already receives for the
`pendingToken` guard) — no new parameter threading needed for either. On
mismatch, aborts before the network call, leaving the row exactly as if the
push hadn't run yet. This also closes a narrower, already-latent version of
the same race in the guest-to-account direction (confirmed, not assumed,
via `storage.pushIdentityGuard.test.js`): a guest attempt's stray push can
no longer land under whatever account happens to be logging in while it's
in flight, which could previously survive a subsequent Discard.
`storage.identity.test.js` (lines 72-102) was re-checked and reconfirmed
NOT racing this bug (its guest push resolves `session: null` synchronously,
before the test's own mock switch, per JS's run-to-completion semantics) —
left unchanged.

**Commit 2/2 — pull-side identity-resolution fix (#1f):** `pullRemoteAttempts`
resolves identity/session at multiple points within one pull operation;
`syncPreferences`'s pull branch does too, narrower. Two different fixes, not
one, matched to what each function's second resolution is actually for:
- `pullRemoteAttempts`: identity is pinned once (`session.user.id`,
  immediately after this function's own session check) and threaded through
  the two calls that sit after this function's real network round-trip —
  the dedup check (`getAllAttempts({ identity })`, its existing override)
  and the watermark write (the already-private `savePreferencesFor`
  directly, not the public `savePreferences`, so no new public surface was
  needed) — eliminating the divergence rather than detecting it, since
  neither call has any legitimate reason to re-resolve identity
  independently. The one resolution point traced as unreachable to this
  race (`getPreferences`, immediately after the session check — no
  network/IndexedDB operation between them, a pure microtask chain no
  browser click can interleave) is deliberately left auto-resolving, with
  an inline comment at that exact site — flagged there, the same way
  `adoptLegacyDataIfSafe`'s own guest-vs-stranded heuristic is flagged
  above, as a **time-limited guarantee**: if a future edit inserts a real
  `await` between that session check and `getPreferences()`, this
  unreachability claim must be re-verified, not assumed to still hold.
- `syncPreferences`'s pull branch: this one's second `getSession()` call
  genuinely authenticates the outbound query and correctly handles the
  guest case, so it gets a real compare-and-abort guard instead of
  elimination — a single mutable row has no dedup/append safety net, so any
  write under uncertain identity is corruption, not just a duplicate. On a
  detected mismatch it re-resolves and retries once, fresh, within the same
  trigger (a bounded recursive call, `retriesLeft` capped at 1) rather than
  silently dropping forever; if the retry also mismatches, it defers
  cleanly to the next trigger (a fresh login or foreground event already
  re-invokes this function via `App.jsx`'s `runSyncSequence`) instead of
  looping.

Both commits' adversarial cases were run (each fix temporarily reverted,
confirmed the specific tests then fail for the traced reason, then
restored): `storage.pushIdentityGuard.test.js`,
`storage.pullIdentityGuard.test.js`. Full suite: 10 files, 46 tests, all
passing as of this build.

**Live verification (2026-09-14): done, clean, both closed.** This build
has no UI surface at all (pure `storage.js` logic), so DOM/viewport
smoke-testing did not apply — confirmed, not overlooked. What did apply was
a live verification against the real Supabase project, matching both
investigation docs' own Level 2 plans: `TEST_FIXTURE_KEEP` plus one fresh
throwaway account, a controllable `getSession()`/`fetch` wrapper around a
real `@supabase/supabase-js` client to force the exact same-page-load
identity-switch race, confirmed server-side via direct Postgres reads (not
client-side inference) for every scenario —
- **#1e attempts push guard**: an in-flight push queued under A, forced to
  resolve its own session check as B mid-flight, confirmed to land under
  *neither* account (not misdirected to B, not silently landed under A
  either) — then confirmed a real `flushUnsyncedAttempts()` correctly
  recovers it under A afterward, so nothing is permanently lost.
- **#1e preferences push guard**: same race; confirmed B's real settings
  were never overwritten with A's stale values, and A's own server row was
  byte-for-byte unchanged.
- **#1f `pullRemoteAttempts`**: confirmed it pulls correctly under the
  identity pinned at the top of the operation; a live attempt to switch
  sessions mid-network-call was confirmed to have zero effect (the query
  filter and auth header are already fixed before the request is
  dispatched — a positive property of eliminating the divergence rather
  than detecting it, not a gap in the test).
- **#1f `syncPreferences` pull branch**: confirmed, via a logged sequence
  of real `getSession()` calls (not inferred from code), that a detected
  mismatch actually retries once, fresh, and correctly pulls under
  whichever identity is live by then, leaving the other identity's record
  untouched; and separately confirmed that a mismatch on the retry too
  defers cleanly (bounded to exactly 2 attempts, no write, no hang) rather
  than dropping silently forever.

Two throwaway accounts were created and fully cleaned up across the two
live-verification passes (2026-09-12's build pass and 2026-09-14's
completion pass) — each confirmed via captured console output showing
empty `puzzle_attempts`/`preferences` after deleting its `profiles` row
(cascade). `TEST_FIXTURE_KEEP` was confirmed bit-for-bit restored after
each pass (exact structural equality between the captured before/after
state, not just "looks empty"). As with the theme/preferences live
verification, the underlying synthetic `auth.users` row for each throwaway
cannot be deleted without a service-role key (not present in this
project's local `.env`) — data-level cleanup only, consistent with this
project's established practice. The verification scripts themselves were
one-off, not committed (hit real network and real accounts, unsuitable for
regular/CI runs), and were deleted after running.

### Logout (Backlog #2) + Settings Account reorg (Backlog #3, 3-commit build)

Full investigation: `docs/specs/logout-investigation.md`. **All three commits
are built, tested, live-verified, and committed (not pushed — awaiting
sign-off). Both backlog items closed.**

**Gate Step 0 (required before any logout code was written): resolved and
concretely re-verified, not assumed — landed as part of Commit 1
(`fcf9ccb`).** The investigation's own §5 risk 5 ("`adoptLegacyDataIfSafe`
remains correct as-is") was traced under an assumption about how logout
resets state that couldn't be tested until logout actually existed. Before
writing any logout code:
- **Decision:** logout is a plain in-memory SPA state reset — `session`/
  `sessionStatus`/`displayName`/`launchDismissed` reset via `setState`
  calls inside `App.jsx` — **not** a full page reload.
- **Re-verification, concrete, against the actual entry point:**
  `src/main.jsx` calls `createRoot(...).render(<App />)` exactly once, at
  module load, unconditionally — no `key` prop, no conditional wrapper,
  and nothing anywhere in the codebase calls `.render()` a second time or
  changes what's rendered at the root. React only unmounts/remounts a
  component when its parent stops rendering it or its `key` changes;
  neither ever happens to `<App />` here. **This means `App`'s own boot
  effect (`useEffect(() => {...}, [])`, the sole call site of
  `adoptLegacyDataIfSafe`) fires exactly once for the entire lifetime of
  the tab — logout cannot re-trigger it, no matter how many guest/account
  transitions happen afterward in that same session.** The "once per real
  page mount" guarantee the adoption routine depends on holds under the
  chosen mechanism.
- **Conclusion:** gate passed — proceeding with the in-memory-reset design
  does not reopen the adoption routine's safety, so Commits 1-3 were not
  blocked on this. Documented at both call sites in `App.jsx` (the boot
  effect's own doc comment, and `handleLogout`'s) as well as here.

**Commit 1/3 — Logout mechanics (`fcf9ccb`):** `handleLogout` calls
`supabase.auth.signOut()`, resets the four pieces of React state named
above, then explicitly reloads preferences for the newly-resolved (guest)
identity and re-applies the theme via a new `loadAndApplyPreferences()`
helper — extracted out of the boot effect itself (rather than duplicated)
specifically because logout doesn't remount `App`, so nothing else will
re-run that load automatically. No flush-before-logout step: safe to
abandon in-flight pushes, now that #1e/#1f's identity-pinned guards are
live-verified — a push either completes correctly under its already-pinned
identity or aborts cleanly on a mismatch, and `signOut()` itself makes any
push that reads `getSession()` afterward see no session and no-op via its
own pre-existing guard. "Logout" and "switch to guest mode" are confirmed
the same end state (per the investigation's finding) — this just returns
to the launch screen. Logout is gated by the same `puzzleAttemptInFlight`
signal Login/Create Account already use. Tests:
`src/utils/storage.logoutInFlightPush.test.js` (the exact signOut()-mid-push
scenario, for both attempts and preferences, adversarial case included per
the existing project pattern).

**Commit 2/3 — Settings Account reorg (`665b186`):** the logged-in-only
"Profile" section is now "Account," containing display name (unchanged
behavior, just relocated), a Backlog #4 placeholder row (sequence/
credential reset — deliberately non-functional, not scoped here), and
Logout (a plain destructive-styled button, not `OptionButton`). Board
Theme/Piece Movement stay untouched and structurally separate, per the
investigation's finding.

**Commit 3/3 — round-trip verification: done, live-verified (2026-09-14).**
Login → change display name → logout → relogin, confirmed via a real
running dev server against `TEST_FIXTURE_KEEP` (session minted through the
real `verify-move-sequence` Edge Function, injected into the browser rather
than automating the sequence-board's drag gestures — that input is already
documented above as a temporary placeholder, not worth building brittle
automation against): the new name persisted correctly across the real
`signOut()` → relogin boundary, confirmed both via the rendered input value
and screenshots. Closes the backlog's "still pending final round-trip
verification" note (theme/preferences-sync section above) — board theme
never needed this, per that section's own 2026-09-12 live verification;
only display name did, and it's now confirmed too. `TEST_FIXTURE_KEEP`'s
`display_name` was restored to its original value afterward, confirmed via
a direct read (not just a successful write call).

**Two real bugs found during this live-DOM verification pass — this is
exactly what it's for:**
1. **Fixed, same pass (`adbaf93`): Logout left the Settings panel open
   behind the relaunched LaunchOverlay.** `handleLogout` reset session
   state but never touched `settingsOpen`; since both `LaunchOverlay` and
   `SettingsPanel` are independent `fixed inset-0` overlays at the same
   z-index tier, logging out while Settings was open stacked both at once
   instead of cleanly returning to just the launch screen. Fixed by adding
   `setSettingsOpen(false)` to `handleLogout`; reconfirmed via a second
   live run that only the launch screen renders now.
2. **Found, explicitly NOT fixed — out of this build's scope, needs its own
   backlog item so it doesn't get lost:** `DisplayNameFields`
   (`SettingsPanel.jsx`) initializes its input from the `displayName` prop
   **once, at mount, with no sync-with-props effect** — a deliberate
   design choice recorded in its own comment, premised on "`SettingsPanel`
   remounts fresh every time it opens." That premise fails if Settings is
   opened before the async `displayName` fetch effect (`App.jsx`, keyed on
   `[sessionStatus, session]`) has resolved: the field mounts with an
   empty value and — because it never re-syncs — stays empty for as long
   as that particular panel-open lasts, even after the fetch completes
   moments later. **Not specific to logout or this build** — reachable
   from any sufficiently fast click on the gear icon right after any fresh
   login, confirmed reproducible via a real timed test run (opening
   Settings immediately after a page reload with a valid session showed
   this exact empty-field state; adding a short wait for the fetch before
   opening Settings avoided it). **New backlog item needed**: either give
   `DisplayNameFields` a sync-with-props effect, or gate Settings-panel
   readiness on the fetch completing — a real design decision, not a
   one-line patch to rush through inside this build.

**New backlog item (unnumbered, needs triage): `DisplayNameFields`
mount-race** (found above) — give it a sync-with-props effect, or gate
Settings-panel readiness on the `displayName` fetch completing. Not
blocking anything; not yet assigned a backlog number.

### Profile/themeStats pull-down missing on login (Backlog #1g, NEW, blocking)

Full investigation: `docs/specs/guest-merge-profile-migration-investigation.md`. Found while
live-verifying the full guest-to-account adoption flow end-to-end (2026-09-14) against production
Supabase, reproduced cleanly across two independent throwaway accounts. **Built, tested, and
live-verified against production Supabase (2026-09-14) — closed.**

**The bug, as found:** `migrateGuestDataToAccount` (`LaunchOverlay.jsx`) correctly migrates
`puzzle_attempts` (reassigns `ownerId` in place) and remote `preferences`, and calls
`recompute_stats()` — but that RPC only ever wrote server-side `profile_stats`/`theme_stats`;
nothing anywhere in `src/` ever pulled those back down into the local `profile`/`themeStats`
IndexedDB stores (confirmed via a full grep: `profile_stats` appeared in exactly one place in
`src/`, a code comment, never a query). Local `preferences` only appeared to recover after Merge by
coincidence — an unrelated mechanism (`syncPreferences`'s pull branch, riding the login-trigger
`runSyncSequence`) happens to repopulate it; nothing equivalent existed for `profile`/`themeStats`.

**Not scoped to Merge alone** — this was the broader finding that reframed the original report. The
identical gap fired on ANY ordinary Login where the device had no local `profile`/`themeStats`
record for that identity — most plainly, an existing account's second device: attempts pulled down
correctly via the already-working `pullRemoteAttempts()`, but rating/streak/theme-accuracy silently
stayed at `DEFAULT_PROFILE`/empty, right next to the correct attempt history. This directly
contradicted `docs/specs/Sharpin_Spec_AccountSync.md`'s own stated design — **§5's Login flow says
"On success → pulls account data (rating, streak, needs-work areas) from Supabase," and its
boot-routing section assumes "account data is already local/cached from the last sync" — neither
was actually implemented before this build; this backlog item closes that specific gap, and §5's
description is now accurate.** `docs/specs/storage-partitioning-investigation.md`'s own
"second-device scenario" analysis (lines 652-664) came within one sentence of naming this exact gap
and stopped short — it confirmed `attempts` recovers via `pullRemoteAttempts()` and concluded the
scenario "unaffected," without ever checking whether `profile`/`themeStats` recover by any
mechanism. They didn't, until this build.

**The fix (`storage.js`'s `pullProfileStats()`, wired into `App.jsx`'s `runSyncSequence`):** a
pull-down for `profile_stats`/`theme_stats` parallel to how `preferences` already pulls down,
placed right after `recompute_stats()` in the same login/foreground sequence — covers both
reachable paths (guest-to-account Merge, since Merge's `onAuthenticated` → `sessionStatus: 'valid'`
transition fires this same effect next render; and ordinary Login on any device, since that's the
effect's own trigger condition) without touching `migrateGuestDataToAccount`'s own already-correct
attempts/preferences migration logic at all. Deliberately an **unconditional overwrite**, not
`preferences`' guarded push/pull-with-`pendingToken` shape — confirmed, not assumed, that
`profile_stats`/`theme_stats` have no locally-pending-edit concept to protect against a clobbering
pull (nothing in this codebase ever writes them via a user action; they're a pure, wholesale
server-recomputed aggregate every time `recompute_stats()` runs), so the extra guard machinery
`preferences` needs for a real reason would have been over-built here. Tests:
`storage.pullProfileStats.test.js` (second-device case, unconditional-overwrite property, safe
no-op branches, and the adversarial guest-history-survives-Merge case — verified to fail for the
traced reason with the fix temporarily disabled, then restored); `LaunchOverlay.migration.test.jsx`
gained one added assertion confirming `migrateGuestDataToAccount` correctly does NOT write local
profile/themeStats itself (closing that test's own coverage gap explicitly, rather than leaving it
silently absent).

**Live verification (2026-09-14): done, clean, both reachable paths confirmed.** Two phases, real
UI + real production Supabase throughout, both mobile/desktop screenshots captured —
- **Merge case** (fresh throwaway account): guest played 5 real puzzles (genuine drag-solved,
  rating 1272/5 solved/14 theme keys), Created Account, Merged. Local `profile`/`themeStats` for
  the new account matched the guest baseline exactly (previously: no local record at all, silent
  reset to defaults) — confirmed via direct IndexedDB read, polled (not a fixed sleep) until the
  background sync sequence settled. Remote `profile_stats`/`theme_stats`/`puzzle_attempts` all
  confirmed matching via direct Postgres reads. Throwaway account fully cleaned up afterward,
  confirmed via captured output including cascade to `profile_stats`/`theme_stats`.
- **Second-device case** (`TEST_FIXTURE_KEEP`, on a brand-new Playwright browser context with
  empty IndexedDB — the real second-device condition, not simulated): ordinary Login (not Create
  Account) produced a real local `profile` record for the first time ever on this "device" (was
  structurally impossible pre-fix), matching remote `profile_stats`/`theme_stats` exactly via
  direct Postgres reads. `TEST_FIXTURE_KEEP`'s own rows confirmed bit-for-bit unchanged before vs.
  after — `profiles` fully identical (no write path touches it in this flow), `profile_stats`/
  `theme_stats` identical on every VALUE column, with `updated_at` correctly predicted to advance
  (both tables' `_set_updated_at` triggers fire unconditionally on any upsert, confirmed directly in
  `20260819140000_init_schema.sql:138-144`) — a known, harmless side effect of the already-idempotent
  `recompute_stats()` re-running, not corruption, and reported as such rather than glossed over.

### Backlog #1d — usePuzzleEngine rating corruption, expanded to user changes (`a8a7b37`, pushed 2026-10-09)

Investigation: `docs/specs/usepuzzleengine-rating-corruption-investigation.md`. Scope expanded by
Auth V2 spec D12. **Closed, live-verified against production.**

- `usePuzzleEngine({ readyIdentity })`: App passes the identity whose profile is ready, or null.
  Puzzles load only for that identity. On a change, the current puzzle is discarded, and a new one
  loads from the new identity's band once it's ready. With no options, the hook keeps the old
  ungated behavior, which only the Race B timing harness uses.
- Readiness: the guest is ready right after `adoptLegacyDataIfSafe` returns (boot) and after
  `signOut` (logout). An account is ready only once a sync's `pullProfileStats` returns
  `{ identity, ok: true }` for it. If that fails, it falls back to an existing local profile
  record for it; with none, the board stays on "Loading puzzle…" until a foreground sync succeeds.
- Commit guard: blocked unless the puzzle's pinned identity is still ready and still the live
  session. The profile read and `recordAttempt` are both pinned to that identity.
- `runSyncSequence` queues one follow-up run instead of skipping while a run is in flight.
- Tests: `src/App.bootReadiness.test.jsx` (Race A, Race B) and `src/App.userChange.test.jsx`
  (login, logout, guard, restored session). Race A and all four user-change tests fail against
  pre-fix code; Race B does not reproduce in jsdom, matching the doc's 2026-09-20 addendum.
- **Not covered:** merging guest history into an *existing* account (D11: not merged; separate
  backlog item).

**Live-check record, 2026-10-09, production, TEST_FIXTURE_KEEP (authorized), verbatim:**

Snapshot before (`supabase db query --linked`):
```
{
  "anomaly_count": 0,
  "attempt_count": 0,
  "best_streak": 0,
  "current_streak": 0,
  "display_name": "TEST_FIXTURE_KEEP",
  "id": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "last_attempt_at": null,
  "rating": 1200,
  "rating_from_deltas": 1200,
  "stats_updated_at": "2026-09-14 18:05:49.193818+00",
  "total_failed": 0,
  "total_solved": 0
}
```

Summary (tester's own words):
- 2a missed (captured pre-auth, sub null). 2c caught the pending window: sub set, displayedRating "—", no puzzle.
- Round 1: commit delta -12 from the fixture's 1200 (guest at 1154 would give -10).
- Round 2: reloaded once to get a puzzle that could distinguish the two bases (1106 couldn't; nothing was committed on it). Puzzle 1150: delta -13 from 1188 (1200 would give -14). Fixture now 1175.
- Logout restored the guest (1154) both times. Guest row and attempts unchanged throughout.

```
=== RAW EVIDENCE (browser console, 2026-10-09) ===

--- 1-guest-before-login ---
{
  "step": "1-guest-before-login",
  "at": "2026-10-09T15:00:24.410Z",
  "sub": null,
  "displayedRating": "1154",
  "displayedPuzzleRating": "1086",
  "profileRows": [
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false }
  ]
}

--- 2a-login-pull-pending (captured pre-auth; counts as missed) ---
{
  "step": "2a-login-pull-pending",
  "at": "2026-10-09T15:02:46.885Z",
  "sub": null,
  "displayedRating": "1154",
  "displayedPuzzleRating": "1073",
  "profileRows": [
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false }
  ]
}

--- 2b-after-login ---
{
  "step": "2b-after-login",
  "at": "2026-10-09T15:03:13.599Z",
  "sub": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "displayedRating": "1200",
  "displayedPuzzleRating": "1213",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1200, "totalSolved": 0, "totalFailed": 0, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false }
  ]
}

--- 3-after-commit ---
{
  "step": "3-after-commit",
  "at": "2026-10-09T15:04:23.639Z",
  "sub": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "displayedRating": "1188",
  "displayedPuzzleRating": "1213",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1188, "totalSolved": 0, "totalFailed": 1, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true }
  ]
}
sharpinExpected(1200, 1213, false) → {delta: -12, newRating: 1188}
sharpinExpected(1154, 1213, false) → {delta: -10, newRating: 1144}

--- 4-after-foreground-sync ---
{
  "step": "4-after-foreground-sync",
  "at": "2026-10-09T15:05:41.263Z",
  "sub": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "displayedRating": "1188",
  "displayedPuzzleRating": "1213",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1188, "totalSolved": 0, "totalFailed": 1, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true }
  ]
}

--- 5-after-logout ---
{
  "step": "5-after-logout",
  "at": "2026-10-09T15:07:19.029Z",
  "sub": null,
  "displayedRating": "1154",
  "displayedPuzzleRating": "1189",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1188, "totalSolved": 0, "totalFailed": 1, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true }
  ]
}

--- 2c-relogin-pull-pending ---
{
  "step": "2c-relogin-pull-pending",
  "at": "2026-10-09T15:12:38.520Z",
  "sub": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "displayedRating": "—",
  "displayedPuzzleRating": null,
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1188, "totalSolved": 0, "totalFailed": 1, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true }
  ]
}

--- 2d-after-relogin (puzzle 1106; not committed — could not distinguish bases) ---
{
  "step": "2d-after-relogin",
  "at": "2026-10-09T15:12:50.216Z",
  "sub": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "displayedRating": "1188",
  "displayedPuzzleRating": "1106",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1188, "totalSolved": 0, "totalFailed": 1, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true }
  ]
}

--- 3b-after-commit (after one reload; puzzle 1150) ---
sharpinExpected(1188, 1150, false) → {delta: -13, newRating: 1175}
sharpinExpected(1200, 1150, false) → {delta: -14, newRating: 1186}
{
  "step": "3b-after-commit",
  "at": "2026-10-09T15:19:29.174Z",
  "sub": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "displayedRating": "1175",
  "displayedPuzzleRating": "1150",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1175, "totalSolved": 0, "totalFailed": 2, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true },
    { "id": 6, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "pZLRh", "solved": false, "hintUsed": true, "ratingDelta": -13, "synced": true }
  ]
}

--- 4b-after-foreground-sync ---
{
  "step": "4b-after-foreground-sync",
  "at": "2026-10-09T15:20:21.601Z",
  "sub": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "displayedRating": "1175",
  "displayedPuzzleRating": "1150",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1175, "totalSolved": 0, "totalFailed": 2, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true },
    { "id": 6, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "pZLRh", "solved": false, "hintUsed": true, "ratingDelta": -13, "synced": true }
  ]
}

--- 5b-after-logout ---
{
  "step": "5b-after-logout",
  "at": "2026-10-09T15:20:56.633Z",
  "sub": null,
  "displayedRating": "1154",
  "displayedPuzzleRating": "1164",
  "profileRows": [
    { "key": "1e119080-4dd7-46be-a56f-9c54ca46c743", "value": { "rating": 1175, "totalSolved": 0, "totalFailed": 2, "currentStreak": 0, "bestStreak": 0 } },
    { "key": "guest", "value": { "rating": 1154, "totalSolved": 0, "totalFailed": 4, "currentStreak": 0, "bestStreak": 0 } }
  ],
  "attempts": [
    { "id": 1, "ownerId": "guest", "puzzleId": "KQJNu", "solved": false, "hintUsed": false, "ratingDelta": -6, "synced": false },
    { "id": 2, "ownerId": "guest", "puzzleId": "ITSf4", "solved": false, "hintUsed": false, "ratingDelta": -13, "synced": false },
    { "id": 3, "ownerId": "guest", "puzzleId": "WaE5t", "solved": false, "hintUsed": false, "ratingDelta": -12, "synced": false },
    { "id": 4, "ownerId": "guest", "puzzleId": "ZZLnr", "solved": false, "hintUsed": false, "ratingDelta": -15, "synced": false },
    { "id": 5, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "3kxV9", "solved": false, "hintUsed": true, "ratingDelta": -12, "synced": true },
    { "id": 6, "ownerId": "1e119080-4dd7-46be-a56f-9c54ca46c743", "puzzleId": "pZLRh", "solved": false, "hintUsed": true, "ratingDelta": -13, "synced": true }
  ]
}
```

Snapshot after (`supabase db query --linked`):
```
{
  "anomaly_count": 0,
  "attempt_count": 2,
  "best_streak": 0,
  "current_streak": 0,
  "display_name": "TEST_FIXTURE_KEEP",
  "id": "1e119080-4dd7-46be-a56f-9c54ca46c743",
  "last_attempt_at": "2026-10-09 15:19:18.621+00",
  "rating": 1175,
  "rating_from_deltas": 1175,
  "stats_updated_at": "2026-10-09 15:20:10.326482+00",
  "total_failed": 2,
  "total_solved": 0
}
```

### Auth V2 (October 2026) — email + move-sequence password

Spec: `docs/specs/Sharpin_Spec_AuthV2.md` (decisions D1–D17). Build order (§10): #1d (expanded) →
schema/auth backend → client auth UI → logout and local-cache clearing → account deletion →
data migration. One commit per item.

**Step 1 — schema and backend (`c2e54d7`, pushed 2026-10-09): done.**
- V1 functions `verify-move-sequence` and `create-account` undeployed; their source and
  `_shared/mint-session.ts` deleted. `update-profile` and `_shared/validate-display-name.ts` kept.
- Migration `20261009170000_auth_v2.sql` applied: dropped `profiles_move_sequence_hash_key`,
  `profiles.move_sequence_hash`, `verify_attempts` and `create_account_attempts`; added
  `handle_new_user()` (security definer, `search_path = ''`, inserts `(id)` on conflict do nothing)
  and the `on_auth_user_created` trigger.
- Post-checks matched the backup exactly (row counts 2/25/40/2/2/0/2; both accounts' attempts and
  `profile_stats` unchanged).
- Trigger proven with an auto-confirmed dashboard test user (`horacetiggsiv+trigger@gmail.com`,
  id `d50b2704…`): created → `profiles` row inserted (display_name null) → user deleted → profile
  row cascaded away → counts back to baseline. Its 64-character hex password was accepted.
- **Dev login and create-account fail until the client UI step** (the client still calls the
  undeployed V1 functions). Production users are unaffected (`VITE_ENABLE_ACCOUNT_SYNC` is off).

**Supabase Auth dashboard config, applied 2026-10-10:**
- Email provider ON. Confirm email ON. Secure email change ON.
- **Secure password change ON (A4)** — recovery and change-sequence both produce a fresh sign-in,
  and it blocks sequence changes from a stolen session.
- **Require current password OFF — must stay off; turning it on breaks forgot-sequence** (a
  recovery session has no current password to supply).
- Minimum password length 64. Required characters: none (lowercase hex must always pass).
- Signups ON. Anonymous sign-ins OFF. Manual linking OFF.
- Site URL `https://sharpin-your-game.vercel.app`. Redirect URLs: `http://localhost:*/**`,
  `https://sharpin-your-game.vercel.app/**`. Vercel preview redirects (checklist item C4) skipped,
  so auth links don't work on preview deployments.
- Rate limits at defaults: sign-ups/sign-ins 30 per 5 min, token refreshes 150 per 5 min.
- **Not yet configured:** custom SMTP (Resend) and the email templates. Until then the built-in
  mailer only sends to team members, about 2 per hour.

**Client build note — change-sequence:** the `signInWithPassword` call that verifies the current
sequence must also provide the session `updateUser` runs on. A4 requires a session under 24 hours
old; verifying on a separate client and updating from the old session would fail.

**Client UI step acceptance additions:** with A4 ON, confirm that change-sequence succeeds (new
sequence works, old rejected) and that the forgot-sequence reset succeeds.

**Next candidates after Auth V2:** the `DisplayNameFields` mount-race above, the "Personal Analytics
UI" item from the AccountSync spec (§7 — that spec's backlog numbering was never reconciled with
this repo's), and the theme-tag capitalization item below.

## Explicitly out of scope right now
- Custom "Sharpin" wordmark/logo design — plain styled text only.
- Difficulty setting — backlog item, do not build.
- Click-to-move input rework — separate backlog item, not this task.

## HISTORICAL (V1) — 4-move-sequence login can silently authenticate into the wrong account; no recovery mechanism exists

**Status: superseded by Auth V2.** This describes the retired V1 model, where the sequence was the
only credential. Auth V2 separates identifier (email) from secret (sequence), so a mis-entered
sequence can no longer match another account (Finding B). Forgot/change-sequence (Finding A,
backlog #4) are Auth V2 client-step features. Kept below as the record that motivated Auth V2.

**Found:** manual end-to-end test, guest→account→merge→logout→relogin flow, 2026-10-06.

**Summary:** Sharpin's account auth uses no email/password — users choose a permanent 4-move chess-move sequence as their credential (confirmed intentional design, not a bug). Two real problems were found with this model during testing, one confirmed by direct test, one inferred from evidence and partially confirmed.

**Finding A — No account recovery path (confirmed by design, not yet built):** there is no stated or observed mechanism to recover or reset a forgotten 4-move sequence. A user who forgets their sequence loses access to their synced profile/stats permanently, with no apparent path back. This was flagged during account creation, before any bug was found — the design itself has this gap regardless of what follows below. This may be the same gap as backlog #4's 'Change sequence — coming soon' placeholder (SettingsPanel.jsx:96-102) — check before assigning a new backlog number, as this could be a duplicate rather than a new item.

**Finding B — Mis-entering a sequence can silently log in as a different real account (strong inference, not fully proven):**

During testing, after creating a new account and completing Merge, the tester logged out and back in intending to re-enter the new account's sequence. The resulting session decoded (via the Supabase JWT in localStorage) to a different ownerId (`be6c5c2e-15a3-4bd5-98d7-2c45035a0dcf`) than the account just created (`5e31328c-aa13-4f8c-a9e6-90dedc550a7e`). The `be6c5c2e` account had five of its own real, Supabase-synced attempts (synced: true, real remoteIds), confirming it is a genuine pre-existing account — via Supabase Auth metadata, created 2026-09-22 under display name "Tee_Eye_Gee_Test_1," from an earlier test session — not corrupted or fabricated data.

At the time this happened, both the local IndexedDB `attempts` store and the login UI showed no indication that the session had switched to a different account's identity — the login simply succeeded and returned a valid session, with no visible mismatch warning.

**Follow-up test — order-sensitivity confirmed correct:** a controlled test (fresh account created with a known, written-down sequence a3/b3/c3/d4; logout; relogin attempted with the same four squares in reversed order d4/c3/b3/a3) correctly failed with "Sequence not recognized -- try again." Relogin with the correct order succeeded and decoded to the correct, matching ownerId. This rules out order-insensitivity as the mechanism — the system does not accept a scrambled version of a known sequence.

**What this leaves unresolved:** the most likely explanation for the Finding B collision is that the tester entered a different, previously-used 4-move sequence (from an earlier test account) rather than the newly created one, and that sequence happened to be valid and match a real pre-existing account. This was NOT directly confirmed — the tester could not reliably recall the two sequences well enough to test this exact scenario cleanly, so it remains the leading inference rather than a proven root cause.

**Why this matters regardless of root cause:** whether the mechanism is user mis-entry, collision, or something else, the demonstrated behavior is that a 4-move-sequence login can succeed into an account other than the one the user intended, with the UI giving no indication that this happened. Combined with Finding A (no recovery path), a user has no way to confirm which account they are in, and no way to recover if they lose track of their own sequence.

**Local-storage context (not a separate bug, folded in here for completeness):** attempts held steady at 5 through the guest-games checkpoint, through Merge, and through logout — it did not change until after the relogin that authenticated into be6c5c2e, at which point it read 10 (the 5 real attempts owned by 5e31328c plus the 5 pre-existing attempts owned by be6c5c2e, both present in the same local IndexedDB). preferences, profile, and themeStats did show elevated counts earlier, right after Merge and before any relogin — that was investigated at the time as possible pull-down-duplication, but code review (storage.js, put()-based replace-by-key writes keyed by identity) found no mechanism for a single account's pull-down to double its own stored records. The most consistent explanation across both observations is that local IndexedDB retains records per-identity indefinitely once pulled to this device — whichever accounts' data has ever synced locally appears to remain present, regardless of which account is currently logged in. Whether this is because writes never clean up other identities' records, or because reads never filter them out, or both, is unconfirmed — see the open question below.

**Raw verification-snippet evidence, 2026-10-06 run, in order:**

| Checkpoint | attempts | preferences | profile | themeStats | localStorage |
|---|---|---|---|---|---|
| After Clear site data (pre-test baseline) | 0 | 0 | 0 | 0 | (empty) |
| After 5 guest games | 5 | 1 | 1 | 12 | (empty) |
| After Merge, before refresh | 5 | 2 | 2 | 24 | sb-wrexmksxphqkanrzzvcd-auth-token |
| After logout | 5 | 2 | 2 | 24 | (empty) |
| After relogin (landed in be6c5c2e, not the account just created) | 10 | 3 | 3 | 41 | sb-wrexmksxphqkanrzzvcd-auth-token |

Session identity at each stage, decoded from the Supabase JWT in localStorage via this console snippet:

    (() => {
      const raw = localStorage.getItem('sb-wrexmksxphqkanrzzvcd-auth-token');
      if (!raw) { console.log('No session found'); return; }
      const session = JSON.parse(raw);
      const payload = JSON.parse(atob(session.access_token.split('.')[1]));
      console.log('Current session user id (sub):', payload.sub);
    })();

- Account created this run: `5e31328c-aa13-4f8c-a9e6-90dedc550a7e`
- Account the relogin actually authenticated into: `be6c5c2e-15a3-4bd5-98d7-2c45035a0dcf` (pre-existing, confirmed real via 5 synced attempts with genuine remoteIds)

The following controlled follow-up test was run separately, on 2026-10-07:

Follow-up controlled test (separate account, used to confirm/rule out order-insensitivity as a mechanism — see "Follow-up test" paragraph above):
- Account created: sequence a3/b3/c3/d4 → decoded sub `28053efb-ea68-4c45-a548-654b66134bdd`
- Relogin attempt with reversed order d4/c3/b3/a3 → UI result: "Sequence not recognized -- try again." (login rejected, no session created)
- Relogin attempt with correct order a3/b3/c3/d4 → decoded sub `28053efb-ea68-4c45-a548-654b66134bdd` (matches, confirmed correct)

**Note:** all three accounts referenced above (5e31328c, be6c5c2e, 28053efb) were deleted during this session's test-account cleanup on 2026-10-07 (one day after the main run), after this evidence was captured. Their server-side data can no longer be re-verified; this entry stands on the evidence captured above, recorded before deletion.

**Open questions for next investigation:**
- Can the exact mis-entry/collision scenario in Finding B be reproduced deliberately (e.g., two accounts created with sequences that are permutations of the same squares, or with deliberately similar-but-different sequences) to confirm the mechanism precisely?
- Profile, preferences, and themeStats are already keyed by identity, and attempts records carry an ownerId field (storage.js:122, :184, :916, :1156) — so records ARE tagged by owner. What's unconfirmed is whether every read path filters by the currently active identity before displaying data, or whether some reads return records regardless of owner. This is a narrower, more specific question than originally framed — the storage schema already supports per-owner filtering; what's unverified is whether it's applied consistently on read.
- What recovery options are feasible for a forgotten 4-move sequence without undermining the no-email/password design intent? (Needs product/design decision, not just engineering — out of scope for investigation alone.)
- Should login surface which account/identity was authenticated (e.g., a confirmation step or account identifier shown post-login) to prevent silent wrong-account logins going undetected?

**Severity:** Finding A (no recovery) — confirmed gap, needs product decision. Finding B (wrong-account login) — confirmed behavior occurred once in testing; root mechanism not fully proven; potentially serious if reproducible by an attacker or if it indicates weak sequence-space collision risk, but current evidence is most consistent with tester error. Needs a real backlog number for both.

## NEW, untriaged — Theme tag capitalization inconsistent; "Discovered Check" missing a definition

**Found:** manual end-to-end test, guest puzzle-solving, 2026-10-06.

- "discovered Check" theme tag displays with inconsistent capitalization (lowercase "discovered", capital "Check") and has no definition/tooltip shown, unlike other theme tags that do show one.
- "master" theme tag displays fully lowercase, inconsistent with other theme tags (e.g. "Endgame", "Crushing") which are capitalized.
- These two instances suggest a broader capitalization inconsistency across the theme-tag set. A full audit of all theme tags and their definitions/tooltips is warranted rather than fixing instances one at a time.

**Severity:** cosmetic/content issue, low priority. Needs a real backlog number.
