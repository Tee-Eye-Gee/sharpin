# Sharpin — CLAUDE.md

## What this is
Mobile-first chess puzzle trainer. React + Vite 8, fully client-side. Coach layer is local rule-based logic (src/utils/coach.js), not AI.

## Tech stack
- React + Vite 8 (Rolldown/Oxc)
- chess.js + react-chessboard
- Tailwind CSS
- IndexedDB (src/utils/storage.js, schema v3) — local persistence, and remains the primary/only storage for guests. Every solve/fail still writes here first, unconditionally, regardless of login state. **Namespaced by identity** (storage-partitioning build, September 2026 — see "Current task"): every store is keyed/tagged by a real account's id when logged in, or the fixed `GUEST_IDENTITY` (`'guest'`) sentinel otherwise, closing a cross-account local-storage leak the ongoing-sync build above didn't originally account for. `adoptLegacyDataIfSafe()` migrates any pre-partitioning local data into the correct namespace, once, on first boot.
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
- All storage access goes through `src/utils/storage.js` — don't touch IndexedDB directly from components. Includes `resetAllLocalData({ identity })` (reset of **one identity's** data across all four local stores back to defaults — a per-identity cursor-based delete, not a wholesale store `.clear()`, since a device can legitimately hold more than one identity's data side by side post-partitioning; used by the guest-to-account migration's Discard path, always called with `{ identity: GUEST_IDENTITY }` explicitly; irreversible).
- `Board.jsx`'s `handlePieceDrop` (move-commit logic) was recently fixed for an underpromotion bug — the piece-choice argument was being silently discarded. Any change touching move input must call this same function, not fork a parallel path.
- All Supabase client calls go through the single shared instance exported by `src/lib/supabaseClient.js` — don't call `createClient()` anywhere else.
- The 3-tier launch/auth screen (Guest / Create Account / Login) is `src/components/LaunchOverlay.jsx`, rendered by `App.jsx` only while `sessionStatus === 'none'`. It also owns the guest-to-account migration dialog (Merge/Discard). Its 4-move-sequence input is a temporary placeholder — see "Current task".

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

## Current task
Account auth & cross-device sync (backlog #1) is **complete for everything currently scoped**, including ongoing sync (six-commit build, September 2026). Full spec: `docs/specs/Sharpin_Spec_AccountSync.md` — §6 has the as-built sync-trigger design. All build stages — local schema v3, the Supabase backend (schema/RLS/Edge Functions, the `recompute_stats()` RPC, sanity-bound CHECK constraints/`anomaly_log`/reconciliation triggers), and the client (session wiring, launch/Login/Create Account UI, guest-to-account migration, ongoing push/pull/recompute sync) — are built, live-verified, and clean **as of that build**. The storage-partitioning build below (September 2026, separate from and after the six-commit build) touches some of this same client code (`LaunchOverlay.jsx`, `App.jsx`) but has only been verified locally (fake-indexeddb, jsdom, a crafted real-`@supabase/supabase-js` fixture) — not against the live Supabase project. Don't read "live-verified" above as still describing the current state of that touched code.

**Ongoing sync, summarized** (see spec §6 for full detail): push is real-time — after every attempt, direct authenticated client write to `puzzle_attempts`, with a `synced` flag + `remoteId`-keyed retry queue for offline/failed pushes. Pull runs on login and on app foreground/resume (Page Visibility API), watermarked via `puzzle_attempts.updated_at` (not the client-set `attempted_at`). Both triggers run pull → flush → recompute in the background, guarded by a ref-based mutex so the sequence never runs twice concurrently. `profile_stats`/`theme_stats` are written exclusively by the `recompute_stats()` Postgres RPC (`SECURITY INVOKER`, no parameters, derives identity from `auth.uid()`) — never a client-side upsert, including from the guest-to-account migration, which now calls this same RPC instead of computing values itself. A non-blocking, log-only sanity-check backstop (`anomaly_log`) flags — but never rejects — a mismatch between what's written and what `puzzle_attempts` actually supports. No live cross-device conflict resolution is built (sequential device usage assumed, matching the spec's logged accepted risk). Theme/preferences sync (below) extends this same push/pull pattern to the single-row `preferences` table.

One item remains deliberately deferred, not forgotten — do not assume it's done:
- **The 4-move sequence input is a TEMPORARY PLACEHOLDER**, not the final design: a plain text/token field, hashed client-side via Web Crypto SHA-256. The real input is board-gesture capture (drag/tap out 4 arbitrary moves on a chessboard-style UI, no chess-legality checking) and needs its own dedicated design pass — it's a genuinely new component, not a tweak to the placeholder. Swap boundary: `src/components/LaunchOverlay.jsx`'s `onSequenceComplete(hash)` callback is the entire contract the rest of that file depends on — the real component replaces the placeholder there without touching Login/Create Account logic, App.jsx, or anything else.

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

**🚩 BLOCKING PRECONDITION — do not enable `VITE_ENABLE_ACCOUNT_SYNC` for
any account with pre-existing local legacy history until this is fixed:**
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

No other task is currently assigned beyond the above. Candidates for what's
next: the `DisplayNameFields` mount-race immediately above, the blocking
fix under storage partitioning above (#1d, `usePuzzleEngine` — still open,
still the one remaining blocking precondition, unrelated to #1e/#1f/#2/#3),
the sequence-input design pass (still deferred, see above), the "Personal
Analytics UI" item per the original sequencing call logged in the
AccountSync spec (§7) — that spec calls it backlog #2, but *this* repo's
own #2 is Logout, now closed; the two numbering schemes were never
reconciled, so don't assume the AccountSync spec's #2 and #7 still point
at the same slot without checking — or Backlog #4 (sequence/credential
reset, the placeholder Commit 2 left in Settings > Account, still
unbuilt).

## Explicitly out of scope right now
- Custom "Sharpin" wordmark/logo design — plain styled text only.
- Difficulty setting — backlog item, do not build.
- Click-to-move input rework — separate backlog item, not this task.
