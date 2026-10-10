# Investigation: Local Storage Partitioning (Guest vs. Account Identity)

Status: **Findings only — no code changes, no commits, no writes to Supabase (local or
production).** For review before logout or theme/preferences sync is built on top of this.
Date: 2026-09-10

Prerequisite reading (per the prompt, both already reviewed): `docs/specs/
logout-and-account-reorg-investigation.md` (the section flagging this as a blocker) and
`Sharpin_Spec_AccountSync.md` §5 (the original "logout leaves local IndexedDB untouched"
decision, written before the ongoing-sync system existed).

---

## 1. Current State, Precisely

### Every IndexedDB store/key in use

Single database, `src/utils/storage.js`: `DB_NAME = 'sharpin'`, `DB_VERSION = 3`. Four object
stores, none namespaced by identity:

| Store constant | Store name | Keying | Value shape |
|---|---|---|---|
| `STORE_PROFILE` | `profile` | out-of-line, fixed key `'main'` (`PROFILE_KEY`) | `{ rating, totalSolved, totalFailed, currentStreak, bestStreak }` |
| `STORE_ATTEMPTS` | `attempts` | in-line, `keyPath: 'id'`, autoIncrement | `{ id, puzzleId, themes, solved, hintUsed, ratingDelta, timeTakenMs, at, synced, remoteId }` |
| `STORE_THEME_STATS` | `themeStats` | out-of-line, key = theme name (string) | `{ attempts, solved }` |
| `STORE_PREFERENCES` | `preferences` | out-of-line, fixed key `'main'` (`PREFERENCES_KEY`) | `{ appMode, boardTheme, inputMode, lastPulledAt }` |

Confirmed by reading `openDB()` (`storage.js:21-44`) and every store's key constant: **there is no
identity dimension anywhere in this schema.** `'main'` is a literal string, not a template over a
profile id; `themeStats` keys are theme names, global across whoever is using the device;
`attempts`' autoincrement key is scoped to the one shared store, not per-identity. Nothing in
`openDB()`'s `onupgradeneeded` branch has ever created a second copy of any store for a second
identity — one browser profile means exactly one `profile`/`attempts`/`themeStats`/`preferences`
row set, full stop, regardless of how many different guests/accounts have used this browser.

### What writes to each store, by phase

Traced directly against `storage.js`, `LaunchOverlay.jsx`, and `App.jsx`:

**Guest play** (`usePuzzleEngine.js`'s `commitAttempt` → `storage.js`'s `recordAttempt`):
- `STORE_ATTEMPTS`: new row appended (`appendAttempt`), `synced: false` at write time regardless of
  login state (`recordAttempt`, `storage.js:435-478`) — the push attempt right after simply no-ops
  if there's no session (`pushAttemptIfPossible`'s own guard, `storage.js:287-290`), so a guest's
  rows stay `synced: false` forever, by design (they were never meant to sync).
- `STORE_THEME_STATS`: bumped every attempt (`bumpThemeStats`).
- `STORE_PROFILE`: rewritten every attempt (`saveProfile`).
- `STORE_PREFERENCES`: written independently, any time app mode/board theme/input mode changes
  (`App.jsx`'s `toggleAppMode`/`selectBoardTheme`/`selectInputMode`), and once on first-ever boot
  (OS-mode detection, `App.jsx:184-199`) — unrelated to login state, guests included.

**Account creation / guest-to-account migration** (`LaunchOverlay.jsx`'s
`migrateGuestDataToAccount`, called from `handleMerge`):
- Reads `STORE_ATTEMPTS` (`getAllAttempts()`) and `STORE_PREFERENCES` (`getPreferences()`) —
  **whatever is currently sitting in the single shared store**, with no way to distinguish "this is
  actually pre-login guest data" from anything else that might be there.
- Writes back to `STORE_ATTEMPTS` only, via `markAttemptsSynced` (flips `synced: true`, backfills
  `remoteId` for pre-existing records) — never touches `STORE_PROFILE`/`STORE_THEME_STATS` locally
  or remotely (those are `recompute_stats()`'s job now, server-side).
- `handleDiscard` calls `resetAllLocalData()` — the one function that already resets **all four**
  stores atomically back to defaults (`storage.js:494-505`).

**Ongoing sync push** (`pushAttemptIfPossible`, fired after every `recordAttempt` and by
`flushUnsyncedAttempts`'s retry loop): reads/writes `STORE_ATTEMPTS` only (`markAttemptSynced`).

**Ongoing sync pull** (`pullRemoteAttempts`): reads `STORE_PREFERENCES` (`lastPulledAt` watermark),
writes new rows into `STORE_ATTEMPTS`, writes the advanced watermark back into
`STORE_PREFERENCES`. Does not touch `STORE_PROFILE` or `STORE_THEME_STATS` (those are locally
still whatever `recordAttempt`'s own read-modify-write last left them at — a pulled attempt from a
different device does not itself recompute local rating/streak; that's a pre-existing, separate gap
in cross-device local-display freshness, out of this investigation's scope, noted only so it isn't
mistaken for something this partitioning fix needs to solve).

**Net confirmation:** every phase above writes into the *same four stores*, unconditionally, with
zero identity tagging. The only thing that currently limits blast radius at all is that
`migrateGuestDataToAccount` only *reads* `STORE_ATTEMPTS`/`STORE_PREFERENCES` and only *writes*
`STORE_ATTEMPTS` — it was never a candidate to also corrupt `STORE_PROFILE`/`STORE_THEME_STATS`,
simply because it never touches them.

---

## 2. The Three Options, Evaluated Concretely

### Option A — Namespace all local stores by identity (account id, or a `'guest'` sentinel)

**Concrete implementation shape, given this codebase specifically:**

- No IndexedDB schema/version bump is actually required. `STORE_PROFILE`/`STORE_PREFERENCES` are
  out-of-line stores keyed by an arbitrary string (`'main'` today) — swapping that for
  `` `profile:${identity}` ``/`'guest'` is a pure application-level key change, not a
  `createObjectStore`/`onupgradeneeded` change. `STORE_ATTEMPTS`/`STORE_THEME_STATS` can stay
  exactly as they are and simply gain an `ownerId` field (attempts) or be read/filtered by owner in
  memory after `getAll()` (both stores' current row counts are small enough — one person's puzzle
  history — that a JS-side filter is fine; no new index is required for this to work correctly, only
  to stay fast at a scale this app doesn't have). This is genuinely **additive to the schema**, not
  a rewrite of it.
- Identity resolution can piggyback on the exact pattern already used in `pushAttemptIfPossible`/
  `pullRemoteAttempts` (`storage.js:289`, `:359`): call `supabase.auth.getSession()` inside
  `storage.js` itself and derive `'guest'` when there's no session, the account id when there is —
  meaning **no call site in `App.jsx`, `usePuzzleEngine.js`, or `LaunchOverlay.jsx` needs to start
  passing an identity parameter explicitly.** `getSession()` reads from `localStorage` and is a pure
  local read whenever no session exists at all (a guest has never had one), so this does not
  reintroduce a network call on the guest path — but it should still be short-circuited behind
  `ACCOUNT_SYNC_ENABLED` first (`if (!ACCOUNT_SYNC_ENABLED) return 'guest'`), the same guard already
  used everywhere else in this file, so the "flag off → zero Supabase traffic" invariant holds
  *literally*, not just "no network traffic ends up happening."
- **Migration (`Option A` requires one, per the prompt's framing):** on first run after this ships,
  any record found under the old un-namespaced keys (`'main'`, bare theme names, un-tagged
  `attempts` rows) needs to be adopted into *whichever identity is active at that moment* — mirrors
  the existing `withHintUsedDefault`/`withSyncedDefault` at-read-time-default pattern in shape, but
  this one is a one-time write-back (more like `resetAllLocalData`'s shape: touch all four stores
  once, atomically) rather than a per-read default.

**Where this option genuinely bites — two required, non-optional changes to already-shipped code:**

1. **`LaunchOverlay.jsx`'s `handleCreateAccount` calls `supabase.auth.setSession(data.session)`
   (line 219) *before* checking `getAllAttempts()` for guest history (line 234).** Today that
   ordering doesn't matter (no namespacing exists yet). Under Option A, if storage functions
   resolve "current identity" via `getSession()`, this ordering becomes a real bug:
   `getAllAttempts()` would run *after* the new account's session is already active, so it would
   read the **new account's own (empty) namespace**, not the guest namespace the migration prompt
   is supposed to be checking. The result: the Merge/Discard prompt would silently never appear —
   `existingAttempts.length > 0` would always evaluate against the wrong, empty bucket, and
   `onAuthenticated` would fire directly (`LaunchOverlay.jsx:238-240`), quietly abandoning the
   user's actual guest history instead of asking. **This has to be fixed as part of Option A**, not
   left as a follow-on bug: either read guest-namespaced attempts explicitly before calling
   `setSession`, or reorder the existing-attempts check to run first.
2. **`migrateGuestDataToAccount` (called from `handleMerge`, and `resetAllLocalData` as called from
   `handleDiscard`) both run *after* the session is already active** — by construction, since
   they're only reachable from the migration-prompt view, which only exists after `setSession`
   already succeeded. Both need **explicit, override access to the `'guest'` namespace regardless
   of which identity is "current"** — a plain "resolve current identity automatically" design (as
   proposed above for every other call site) is insufficient here by definition. This means
   `getAllAttempts()`/`getPreferences()`/`resetAllLocalData()` need an optional explicit-namespace
   parameter for this one call path, not just automatic resolution — a small but real addition to
   `storage.js`'s public surface, and one the prompt's framing ("evaluate concretely against this
   codebase") specifically calls for surfacing rather than glossing over.

**Does it fully close the leak, or only reduce it?** Fully closes it, correctly implemented — a
namespaced retry queue (`getUnsyncedAttempts`) can structurally never see a different identity's
rows, so `flushUnsyncedAttempts` can never push someone else's history under the wrong
`profile_id`, and a namespaced `migrateGuestDataToAccount` reads only the real guest bucket. This is
the only one of the three options where the fix is structural rather than best-effort.

**Effect on existing verified behavior:**
- **Guest zero-network-calls:** preserved, contingent on the `ACCOUNT_SYNC_ENABLED` short-circuit
  described above being added correctly — worth an explicit verification pass, since it's a new
  code path in a place that previously had none.
- **Migration idempotency:** preserved, *provided* the two required fixes above are made — without
  them, Option A doesn't just fail to fix the problem, it actively breaks the already-working
  Merge/Discard prompt (finding #1 above). This is the sharpest risk in this option: it looks
  purely additive but has a real dependency on touching `LaunchOverlay.jsx`'s existing control flow
  correctly.
- **Retry-queue mutex (`syncInFlightRef` in `App.jsx`):** untouched — that mutex guards against two
  sync sequences racing within one identity's session; namespacing doesn't change when
  `runSyncSequence` fires, only what data it reads/writes once running.

**Implementation cost:** moderate-to-broad, not high-risk. It touches nearly every exported function
in `storage.js` (all of `getProfile`/`saveProfile`/`getPreferences`/`savePreferences`/
`getThemeStats`/`bumpThemeStats`/`getRecentAttempts`/`getAllAttempts`/`getUnsyncedAttempts`/
`appendAttempt`/`markAttemptsSynced`/`pushAttemptIfPossible`/`pullRemoteAttempts`/`recordAttempt`/
`resetAllLocalData`) plus the two `LaunchOverlay.jsx` fixes above — broad surface area, but
mechanical (add an identity-resolution step) rather than architecturally uncertain.

### Option B — Clear all local sync-relevant data on logout (revert the "leave untouched" decision)

**Concrete implementation:** logout's handler calls the already-existing `resetAllLocalData()`
(`storage.js:494-505`) before or as part of returning to the launch screen. No new function needed.

**Does it fully close the leak?** Yes, fully — not merely reduces it. Once local storage is wiped
at the moment of logout, there is nothing left for a subsequent guest session or a different
account's Create Account/Merge flow to inherit. This is a stronger closure than the framing in the
logout investigation doc implied ("accepting guest continuity is lost" was flagged as the cost, not
as a partial fix) — worth restating plainly: **Option B is a complete fix for the cross-account leak
specifically**, it just pays for that completeness with a real, deliberate product regression
(pre-existing guest continuity across a logout, which spec §5 explicitly promised).

**One real dependency this option has that's easy to miss:** it must be paired with a **flush
before wipe**, not just a wipe. If a `recordAttempt` write completed locally but its
`pushAttemptIfPossible` push was still in flight or had already failed at the moment of logout
(a real, already-identified race — see the logout doc's §2), then wiping local storage without
first attempting `flushUnsyncedAttempts()` **permanently loses that attempt** — it was never pushed,
and it's about to be deleted. This isn't a namespacing concern, it's a straightforward data-loss
risk specific to this option, and it means Option B is not quite "one line" — it's "flush, then
wipe," in that order, with the flush best-effort/short-timeout so it can't hang the logout UI.

**Effect on existing verified behavior:**
- **Guest zero-network-calls:** unaffected — this option touches nothing about how guests are
  detected or gated.
- **Migration idempotency:** unaffected and, if anything, protected more simply than today — a
  fresh, empty local store after every logout means `migrateGuestDataToAccount`'s
  "is there guest history to offer" check is trivially correct (there either is real guest history
  accumulated since the last logout, or there's nothing) with zero risk of an old account's data
  masquerading as guest history.
- **Retry-queue mutex:** unaffected structurally, but see the flush-before-wipe dependency above —
  the *sequencing* of logout relative to an in-flight `runSyncSequence` needs a decision (does
  logout wait for `syncInFlightRef` to clear, or race it?) that isn't needed under Option A, where a
  race is merely inefficient rather than lossy.

**Implementation cost:** low. Smallest of the three by a wide margin.

### Option C — Wipe only sync-specific fields (`synced`/`remoteId`, `lastPulledAt`), keep solve
history/ratings/theme stats as anonymous local numbers

This was raised as the cheapest option in the prior investigation. Re-evaluated here concretely
against the actual sync trigger wiring, it turns out to be **worse than a "milder version of the
Option-A-leak"** — it opens a strictly broader leak surface than doing nothing:

- A new function (there isn't one today) would need to walk `STORE_ATTEMPTS` and reset every row's
  `synced` flag to `false` (dropping `remoteId` too, so a later push can't collide on an id that
  belonged to the previous account), plus reset `preferences.lastPulledAt` to `null`.
- The problem: this makes the ex-account's entire historical attempt log look, to
  `getUnsyncedAttempts()`/`flushUnsyncedAttempts()`, **identical to a fresh batch of genuinely new
  local attempts**. The very next `runSyncSequence` — which fires on *any* subsequent login,
  **including a plain Login to an existing different account, not just Create Account** — would
  silently push all of it into whichever account is now active, via the ordinary background
  retry-queue flush (`App.jsx:137-152`), with **no Merge/Discard prompt gating it at all**. The
  existing prompt only appears from the `handleCreateAccount` path
  (`LaunchOverlay.jsx:234-241`); `handleLogin` has no equivalent check today, and Option C's
  relabeling would make the ordinary Login+background-sync path exploitable for exactly the leak
  this whole investigation exists to close — silently, with no UI moment where a user could say no.
- It does **not** actually fix the underlying identity confusion — it just changes which code path
  the leak travels through (background flush instead of an explicit Merge click), and removes the
  one piece of the current design (the Merge/Discard prompt) that at least makes the leak visible
  and requires an explicit choice.

**Does it fully close the leak, or only reduce it?** Neither — on inspection it **widens** the
leak's surface (adds a silent Login-triggered path) while doing nothing to close the
Merge-triggered path the logout doc already identified. Not recommended at any cost point.

**Effect on existing verified behavior:** actively breaks the migration idempotency guarantee (a
"fresh account, zero prior attempts" precondition — see CLAUDE.md's Test Fixtures note on Commit
6's idempotency test — no longer holds, since "fresh" local data may actually be a relabeled prior
account's history) and turns the retry-queue's fire-and-forget design (previously safe because it
only ever pushed genuinely-this-identity's own attempts) into the actual leak vector.

---

## 3. Interaction With Last Session's Sync Design

**`recompute_stats()` (`supabase/migrations/20260908220000_recompute_stats_rpc.sql`): untouched by
any option, and this is worth stating with confidence rather than hedging.** It is a
`SECURITY INVOKER` Postgres RPC that takes no parameters and derives everything
(`v_profile_id := auth.uid()`) from the caller's own authenticated identity, reading only
`puzzle_attempts` rows RLS already scopes to that identity. It has no client-supplied identity
input to get wrong, and no dependency on what shape local IndexedDB is in — it doesn't know local
storage exists. None of Options A/B/C need to touch this function, its migration, or its RLS
policies. The entire cross-account leak risk lives client-side, in what gets *pushed* to it (via
`puzzle_attempts` inserts) — never in how it computes stats once rows are correctly attributed.

**Watermark logic (`lastPulledAt`, inside `preferences`):**
- **Option A:** automatically becomes per-identity, for free, as a side effect of namespacing the
  `preferences` store itself — no separate change to `pullRemoteAttempts`'s watermark logic is
  needed beyond it reading/writing through the now-namespaced `getPreferences`/`savePreferences`.
  This is a clean win: it closes the "stale wrong-account watermark" risk (logout doc §2, finding
  4) as a byproduct, not as separate work.
- **Option B:** the wipe resets `lastPulledAt` to `null` (via `resetAllLocalData`'s existing
  defaults), which is correct and requires no logic change — a `null` watermark just means the next
  login re-pulls the full `puzzle_attempts` history for whatever account logs in next, which is
  safe (idempotent, dedup'd by `remoteId`) if a little slower on that one pull.
- **Option C:** resetting `lastPulledAt` alone, without namespacing anything else, doesn't fix the
  deeper problem (see §2) — flagged again here only because it's the one piece of C that looks like
  it's doing real work but isn't addressing the actual leak vector.

**Migration `remoteId` reuse logic (`migrateGuestDataToAccount`, `storage.js`'s
`markAttemptsSynced`):**
- **Option A** doesn't change the *reuse* logic itself (still: reuse an existing `remoteId` if
  present, generate one if not, rely on `23505` as success) — it changes *which bucket*
  `getAllAttempts()`/`markAttemptsSynced` operate against, which is exactly the two required fixes
  called out in §2 (read guest-namespace explicitly, regardless of the now-active session).
- **Option B** doesn't touch this logic at all — there's simply nothing left in local storage by
  the time any of it would run again for a new identity.
- **Option C** doesn't touch this logic either, which is precisely the problem: it leaves the reuse
  logic pointed at data it should never have been allowed to see as "local, unsynced, mine."

**Additive layer vs. schema/key rewrite:** Option A is additive at the IndexedDB level (no
`DB_VERSION` bump, no `createObjectStore` changes) but is **not** additive at the `storage.js`
call-site level — it requires the two `LaunchOverlay.jsx` changes in §2 as hard dependencies, not
optional hardening. Options B and C require no schema or call-site changes beyond the (very
different) amount of new logic each needs in the logout handler itself.

---

## 4. Theme/Preferences Sync Interaction

Confirmed (per the prior investigation, re-verified here against `LaunchOverlay.jsx:96-106` and
`storage.js`'s `pullRemoteAttempts`): `preferences` (`app_mode`/`board_theme`/`input_mode`) is
pushed to Supabase exactly once, at account-creation migration time
(`migrateGuestDataToAccount`'s final `supabase.from('preferences').upsert(...)`), and has **no
pull path at all** — nothing in this codebase ever reads the `preferences` table back down the way
`pullRemoteAttempts` reads `puzzle_attempts`.

**Why this matters jointly with partitioning, not independently:**

- Whichever namespacing scheme Option A adopts for the `preferences` store's key (e.g.
  `` `pref:${accountId}` `` vs. a bare `'guest'` sentinel) is the **same scheme the upcoming
  theme/preferences-sync build will need to target** when it adds a real pull path. Building
  partitioning first, with a key scheme theme-sync can just reuse, avoids exactly the double-touch
  the original `AccountSync` spec's own §7 sequencing note was written to prevent ("schema v3...
  happens before this sync work ships, so sync is built against the final schema rather than
  needing to be touched twice"). The precedent is directly on point here.
- If partitioning ships *after* theme-sync instead, theme-sync's new pull path would need to write
  incoming remote preferences into whatever the pre-partitioning single `'main'` key was, and then
  get rewritten again once partitioning lands to target the new per-identity key — the "touched
  twice" outcome the spec precedent exists to avoid.
- One simplification worth noting for whoever scopes theme-sync: unlike `puzzle_attempts`,
  `preferences` is a single row per profile (per the `AccountSync` spec §4's schema and its own
  conflict-resolution note — "per-record LWW on the single preferences row per profile"), so its
  eventual pull doesn't need an incremental watermark like `lastPulledAt` at all — a plain
  fetch-and-compare-`updated_at` (or just always overwrite-if-newer) suffices. Not a partitioning
  concern, but worth flagging now so theme-sync's build doesn't reflexively copy the
  watermark-with-dedup pattern from `pullRemoteAttempts` where it isn't needed.
- **Recommendation for sequencing specifically:** decide and build the namespacing key scheme
  (Option A) *before or alongside* theme-sync, not after — even if the *rest* of Option A's
  migration/wipe mechanics for logout end up shipping on a different timeline. The key scheme is
  the one piece both features must agree on.

---

## 5. Recommendation and Risk

### Recommendation

**Option A (namespace by identity)**, built before or alongside theme/preferences sync rather than
deferred — for three concrete reasons surfaced by this investigation, not just in the abstract:

1. It's the only option that **fully closes** the leak without silently taking away a product
   behavior (guest continuity across logout) that spec §5 explicitly promised and no one has
   agreed to give up. Option B is a legitimate, much cheaper alternative, but it's a real,
   user-visible trade that should be an explicit decision, not the fallback taken because it was
   easiest to build.
2. It's genuinely additive at the IndexedDB schema level — no version bump, no store rewrite — so
   "broad" (touches most of `storage.js`) does not mean "architecturally risky." The two required
   `LaunchOverlay.jsx` changes (§2) are the only places this option has real teeth; both are
   identified precisely enough here to scope directly into a build spec without further
   investigation.
3. It has to happen before theme-sync's own build touches `preferences` anyway (§4) — building it
   now avoids the exact "touched twice" pattern the original `AccountSync` spec's sequencing note
   (§7) was written to prevent, and this codebase has already paid that lesson once.

**If Tiggs would rather explicitly trade away guest-continuity-across-logout for a much smaller
build**, Option B is a reasonable, fully-closing fallback — but it should be that: a deliberate,
named trade at spec time, not a default reached by cost alone. **Option C should not be built at
any cost point** — §2/§3 found it widens the leak's surface (adds a silent Login-triggered path with
no user-visible gate) rather than narrowing it, and actively undermines the migration idempotency
guarantee CLAUDE.md's Test Fixtures section already documents as load-bearing.

### Production Supabase / live-write scope check

Per standing rule, flagging explicitly: **this investigation required no live writes, and this
document proposes none.** Everything above is a client-side (`storage.js`/`LaunchOverlay.jsx`)
and local-IndexedDB question — `recompute_stats()` and its RLS/schema are confirmed untouched by
every option (§3). Whichever option is chosen will eventually need live verification against a real
account (the existing `TEST_FIXTURE_KEEP` test account per CLAUDE.md, or a fresh throwaway account
for the "does Merge/Discard still trigger correctly" checks specifically) — that verification is
out of scope for this investigation-only pass and should get its own before-not-after confirmation
when build work starts, per the standing live-write rule.

### Risk to already-shipped, already-verified behavior

- **Guest zero-network-calls invariant:** at risk only under Option A, only if the
  `ACCOUNT_SYNC_ENABLED` short-circuit is omitted from the new identity-resolution step — flagged
  in §2 as a specific thing to verify, not assumed safe by default.
- **Migration idempotency (Merge/Discard, and the "brand-new account, zero attempts" precondition
  Commit 6's test relies on per CLAUDE.md):** at risk under Option A *unless* the two
  `LaunchOverlay.jsx` fixes in §2 are made — this is the sharpest risk in this whole investigation,
  because Option A can look purely additive and still silently break this exact guarantee if those
  two call sites aren't touched. Safe under Option B. Actively broken under Option C.
- **`syncInFlightRef` mutex:** untouched in its own logic under every option. Only Option B
  introduces a new question this mutex doesn't currently answer — whether logout should wait for an
  in-flight `runSyncSequence` before wiping, or race it (§2's flush-before-wipe dependency). Not a
  risk to the mutex itself, but a new decision point its existence doesn't resolve for free.

---

## Addendum (2026-09-10, follow-up pass): Two Gaps Closed

Follow-up investigation only — no code changes, no commits, no Supabase writes. Answers two
specific gaps in the findings above, requested before a build spec gets locked: (1) whether the
`setSession()`-ordering issue and the migration-function guest-namespace-access issue are live bugs
today or failure modes Option A's own design would introduce, and (2) an end-to-end trace of the
first-boot legacy-data migration path Option A requires, which the findings above named but didn't
walk through concretely.

### 1. Is the `setSession()` ordering issue pre-existing, or introduced by Option A?

**Traced against today's actual code, not just its shape — verdict: today's behavior is correct.
This is a new failure mode Option A's specific design would introduce, not a live bug that exists
independent of partitioning.**

Walking `handleCreateAccount` (`LaunchOverlay.jsx:185-241`) in the order it actually executes,
against a real "guest played for a while, then creates an account" scenario, under **today's
shipped, unpartitioned storage model**:

1. `create-account` Edge Function invoked, returns a minted session.
2. `supabase.auth.setSession(data.session)` (line 219) — this only changes the Supabase client's
   own in-memory/`localStorage` auth-token state. It does not read or write anything in IndexedDB,
   and nothing in `storage.js` reacts to it synchronously or otherwise.
3. `getAllAttempts()` (line 234) — reads `STORE_ATTEMPTS` via a plain `getAll()` on the one shared
   store (`storage.js:194-199`). Confirmed by re-reading the function: it takes no identity
   argument, calls no `supabase.auth.getSession()`, and applies no filter beyond
   `withSyncedDefault`/`withHintUsedDefault` defaulting. **It is physically incapable of returning
   a different result depending on whether `setSession()` has already run** — there is only one
   bucket, and this function always returns everything in it, unconditionally.

So today, calling `getAllAttempts()` before vs. after `setSession()` is observably identical —
the guest's actual local attempt history is what gets checked either way, which is exactly the
correct, intended behavior for deciding whether to show the Merge/Discard prompt. **There is no
live bug here today.** The ordering is inert precisely because nothing downstream of `setSession()`
currently reads identity at all.

The hazard is created specifically by the *one particular implementation choice* the prior
findings proposed for Option A: having `storage.js` **auto-resolve "current identity" by calling
`supabase.auth.getSession()` internally**, so no call site has to change. That specific design
means "current identity," as far as `storage.js` is concerned, changes the instant `setSession()`
resolves — independent of React state, independent of any re-render. Once that design is in place,
step 3 above (`getAllAttempts()`) would run *after* the client's active identity has already
flipped to the new account, so it would read the new account's own (still-empty) namespace instead
of the guest bucket the check exists to find. This is worth stating precisely: it is not an
unavoidable consequence of namespacing local storage in the abstract — it is a consequence of
resolving that namespace from the Supabase client's live session rather than from, say,
`App.jsx`'s own `sessionStatus`/`session` React state (which, notably, does *not* flip to `'valid'`
until `onAuthenticated` fires — and `onAuthenticated` is only ever called *after* the migration
decision is already made, per `LaunchOverlay.jsx:238-240` and `:249`/`:261`). Had Option A resolved
identity from that React state instead, this specific ordering hazard would not arise — though
identity-via-React-state has its own tradeoffs (it would require threading identity through props
into every component that calls `storage.js`, which is exactly the broad call-site surface the
prior findings' `getSession()`-based design was chosen to avoid). Flagging this not to reopen the
implementation choice, but so it's recorded as a deliberate tradeoff of that choice, not a
surprise.

**Conclusion: pre-existing behavior is correct; the fix named in the prior findings is a required
mitigation for a failure mode Option A's own design introduces, not a pre-existing defect being
uncovered.**

### Same question for `migrateGuestDataToAccount` / `handleDiscard`

Same trace, same verdict: **not a pre-existing bug — introduced by Option A's auto-resolution
design.**

`migrateGuestDataToAccount` (`LaunchOverlay.jsx:58-107`) is only ever reachable via `handleMerge`
(line 247), which by construction only fires after the user has already seen and responded to the
migration prompt — meaning `setSession()` has already succeeded and the prompt itself already
confirmed `existingAttempts.length > 0`. Under today's model, `migrateGuestDataToAccount`'s own
`getAllAttempts()`/`getPreferences()` calls (lines 69, 96) are, again, plain unfiltered reads of
the one shared store — correct today, for the same reason as above: there is only one bucket, and
reading it is exactly what "migrate local history into the new account" is supposed to do,
regardless of when relative to `setSession()` it happens.

Under an auto-resolving Option A, by the time `handleMerge` runs, the active identity is
unambiguously the new account (the user has since navigated a whole extra UI screen past
`setSession()`) — so `getAllAttempts()`/`getPreferences()` would read the new account's own empty
namespace, and Merge would silently "succeed" while transferring zero rows. Same root cause,
same verdict: **introduced by Option A's design, not pre-existing.**

`handleDiscard` (line 256) → `resetAllLocalData()` has an analogous but distinct failure mode
worth naming separately: today it correctly wipes the *only* store there is, matching "Discard
means start this device fresh." Under an auto-resolving Option A, if `resetAllLocalData()` also
auto-resolves "current identity" (the new account) and only clears that namespace, it would leave
the actual guest data — the thing Discard is supposed to discard — sitting untouched and orphaned
in the old `'guest'` namespace forever, rather than clearing it. This isn't a cross-account *leak*
the way the Merge case is (no data goes to the wrong account), but it does defeat Discard's actual
intent and leaves stale data behind indefinitely. Same root cause as the other two: all three
require the same explicit, override "operate on the guest namespace regardless of who's currently
active" parameter the prior findings already called for — this addendum just confirms none of the
three are live bugs today, all three are specific, identified consequences of the auto-resolution
design Option A would introduce.

### 2. First-boot migration path for existing unpartitioned data under Option A — traced end to end

**Scenario:** Device D already has real data — synced attempts, profile, `themeStats`,
`preferences` (including a live `lastPulledAt` watermark) — under today's unpartitioned keys, is
currently logged in to a real account, and boots for the first time after Option A ships.

**Step-by-step, against the auto-resolving design the prior findings proposed:**

1. Boot: `App.jsx`'s existing session-check effect (`App.jsx:88-104`) calls
   `supabase.auth.getSession()`, finds the persisted session, sets `sessionStatus: 'valid'`.
2. The login-trigger sync effect (`App.jsx:160-163`) and the preferences-load effect
   (`App.jsx:184-199`) both fire, calling into `storage.js`.
3. Under an auto-resolving Option A, every one of these calls now resolves "current identity" as
   this account's id and looks for records under the *new*, namespaced keys/tags (e.g.
   `` `profile:<accountId>` ``, attempts rows tagged `ownerId === '<accountId>'`). **None of that
   device's actual existing data was ever written with those tags or under those keys** — it's
   sitting under the old bare `'main'` key, bare theme-name keys, and untagged attempt rows,
   because it predates Option A entirely.
4. Result, with no first-run adoption step: `getProfile()` returns `DEFAULT_PROFILE` (rating
   silently resets to 1200), `getAllAttempts()`/`getRecentAttempts()` return empty (puzzle
   selection loses all recent-theme weighting and repeat-avoidance), `getPreferences()` returns
   `DEFAULT_PREFERENCES` (board theme/app mode/input mode all silently reset, and — notably —
   `lastPulledAt` resets to `null`). This is a real, user-visible regression on this device's very
   next boot, not a cosmetic one.

**Does a path to prevent this exist today, or does it need to be built as part of Option A's
scope?** It needs to be built — it does not exist today, and, more specifically, **it cannot ride
along on the mechanism that would normally carry a local-schema migration.** IndexedDB's
`onupgradeneeded` (`storage.js:25-39`) only fires when `DB_VERSION` increases, and only runs the
`if (!db.objectStoreNames.contains(...))` store-creation checks — there is no data-rewriting logic
in there today, and the prior findings' own claim that Option A needs **no `DB_VERSION` bump**
(because the new keying is a pure application-level convention, not a new store shape) means
`onupgradeneeded` **will not fire at all** for this change and is therefore not available as the
hook for this adoption step, even though it's the idiomatic place an IndexedDB schema migration
would normally live. This is worth stating plainly as a correction/precision to the prior
findings: "no version bump needed" is true and remains true for the schema shape, but it has a
direct consequence the prior pass didn't spell out — **the one-time legacy-data adoption has to be
its own bespoke, unconditionally-run-at-boot check** (e.g., "does an un-tagged/legacy-shaped record
still exist under the old key? If so, adopt it into whatever identity is active right now, once,
and mark that done"), not something that piggybacks on IndexedDB's own upgrade event. **This is a
genuine addition to Option A's build scope**, exactly as the prompt suspected — it should be costed
as its own piece of work, not assumed to be covered by "additive, no version bump."

**What happens if the device is a guest (no session) at first boot post-fix?**

At the moment Option A would actually ship, this case has a clean answer, because **logout does
not exist yet** (confirmed in the logout investigation and reconfirmed here — no
`supabase.auth.signOut()` call exists anywhere in `src/`). Without logout, there is no code path
today that could leave one identity's data stranded on a device that's now presenting as a
*different* identity — a device's local data, pre-Option-A, is unambiguously either (a) genuine
guest history (never logged in) or (b) the currently-active account's own data (still logged in,
since there's no way to have logged out). So: if D is a guest (no session) at first boot post-fix,
whatever legacy data it holds is, by construction, real guest data, and adopting it into the
`'guest'` namespace is correct — it is not "silently orphaned" or "incorrectly claimed as the next
guest's," because at this specific moment in the sequencing (Option A shipping before logout
exists) there is no "next guest" distinct from whoever actually produced that data. **This
guarantee is time-limited, though, and worth flagging precisely:** it holds only for the *very
first* boot of each device after Option A ships (the one-time adoption). It does **not** generalize
to "a device with no session always safely owns whatever legacy-shaped data it finds" once logout
ships later — at that point a device could legitimately go guest → account → logout → guest again,
and the *second* guest phase must not re-trigger this adoption path a second time (the "mark that
done" state from the one-time migration needs to make the adoption idempotent/one-shot, not
something that re-fires on every subsequent guest boot). This is a real design requirement for
whatever mechanism marks "already migrated," not just a note in passing.

One narrower edge case worth recording rather than resolving here: a device whose session token
happens to have expired or been revoked exactly between its last close and this first post-upgrade
boot would present as "no session" at the exact moment of the one-time adoption, even though its
legacy local data genuinely belonged to a real account. There is no purely local way to distinguish
that from genuine guest data at adoption time (the client has no server-verified source of truth
once its token is invalid) — worth flagging as a real, narrow ambiguity in the migration design,
not something this investigation resolves, and low-frequency enough that it likely doesn't block a
decision, but it should be a known, named risk rather than an unstated assumption.

### Follow-up (2026-09-10, second pass): the expired-session edge case, traced concretely

Traced directly against the actual installed library code (`@supabase/supabase-js@2.112.3`, whose
session-loading logic lives in `node_modules/@supabase/auth-js/dist/module/GoTrueClient.js`,
`getSession()` at line 2398 → `_useSession` → `__loadSession()` at lines 2496-2579) rather than
assumed from general knowledge of the SDK, since the concrete outcome depends on exactly what that
function does on a refresh failure — and it does something less naive than "any expiry ⇒ null"
that meaningfully changes the answer.

**What `__loadSession()` actually does, read line by line:**

1. No session at all in storage → `{ session: null }` immediately. (Genuine guest — not this edge
   case.)
2. A session exists and its access token is not yet within `EXPIRY_MARGIN_MS` of expiring →
   returned as-is, no refresh attempted. (Normal case — not this edge case.)
3. A session exists and its access token **is** within that margin → `_callRefreshToken(...)` is
   called.
   - Refresh succeeds → the new, valid session is returned. Silent self-heal; not this edge case.
   - **Refresh fails** (lines 2551-2572): the code does **not** simply return `null`. It first
     checks `accessTokenStillValid` — whether the access token's actual, real `expires_at` (not
     just the eager pre-emptive margin) has literally passed yet. If the real expiry hasn't hit yet
     (the refresh attempt failed for some other reason — a transient network blip, or exactly the
     kind of intermittent unavailability this project's own accepted-risk note in
     `Sharpin_Spec_AccountSync.md` §8 already documents for free-tier auto-pause/cold-start) **and**
     the session is still present in storage, this code path deliberately **preserves and returns
     the old session anyway** — the comment in the source calls this out explicitly as a
     "proactive-preserve" fallback, precisely so a soft/transient refresh failure doesn't manufacture
     a false "logged out" state. Only when the access token's real expiry has **also** genuinely
     passed does it fall through to `{ session: null, error }`.

**Consequence for the question asked: the actual reachable "session: null at this exact boot" case
is narrower than "any expiry," and never throws.** `getSession()` has no exception path here at
all — every branch above resolves to a plain `{ data, error }` result. So "does it throw" is
answered directly: **no.** The two remaining candidates from the original question — "silently
skips and retries safely" vs. "misattributes to guest" — resolve to one concrete answer, but only
for the genuinely narrow sub-case where refresh fails **and** the access token's real (not
margin-padded) expiry has already passed. The common soft-failure case (cold-start, a missed beat,
the free-tier pause scenario the spec already accepts as a risk) is **not** actually this edge case
at all — the library's own preserve-on-refresh-failure behavior absorbs it and hands back a still-
valid session, so the migration proceeds against the correct, real account identity as normal.

**When the narrow case does occur (refresh token itself dead/revoked, or the access token's real
expiry has already passed and refresh outright fails), the concrete outcome is: silent
misattribution to `'guest'` — not a safe skip, not a retry, not an error surfaced anywhere:**

1. `App.jsx`'s boot effect (`App.jsx:88-104`) receives `{ session: null }` and sets
   `sessionStatus: 'none'`.
2. The one-shot migration, which (per the design traced above) can only resolve "current identity"
   from this same session state, resolves identity as `'guest'` — there is no error condition here
   for it to detect or defer on; from its point of view this looks exactly like a legitimate guest
   boot.
3. It adopts **all** of this device's legacy data — profile (rating/streak/totals), every attempt
   row, `themeStats`, and `preferences` (including the `lastPulledAt` watermark) — into the
   `'guest'` namespace, and marks the one-shot migration complete. This is a clean, successful-
   looking run with a wrong result, not a failure of any kind the app could detect and react to.
4. **Unless the migration design is deliberately built to defer marking itself complete until a
   real session is confirmed present** (a real design requirement this follow-up surfaces, not
   previously committed to in the first pass) — this is **permanent**, not a "retry next boot"
   situation: the marker is set, so the adoption logic will not run again even after the user
   successfully re-authenticates on this same device later.

**What happens when the user notices and logs back in (concrete, traced through the existing
code):** they use **Login**, not Create Account — it's the same pre-existing account. `handleLogin`
(`LaunchOverlay.jsx:158-183`) establishes a fresh valid session for the correct account id and has
**no migration/merge check at all** (that logic exists only on the `handleCreateAccount` path) — so
nothing here reunites the orphaned `'guest'`-tagged data with the account automatically. From that
point on, this device's account-namespaced local stores are empty (nothing was ever written there),
so locally: rating/streak/theme accuracy display resets to defaults, board theme/app mode/input
mode reset to defaults. But this is where the actual damage turns out to be narrower than it first
appears, because two already-shipped mechanisms partially self-heal it:

- **The account's authoritative state is never actually at risk.** `recompute_stats()` (confirmed
  untouched by this whole investigation, §3 above) derives `profile_stats`/`theme_stats` entirely
  server-side from `puzzle_attempts`, keyed by `auth.uid()` — it has no dependency on this device's
  local storage at all. The account's real rating/streak/accuracy, as stored in Supabase, is
  unaffected throughout this entire scenario.
- **Already-synced attempts are recovered, not lost**, via the ordinary login-trigger
  `pullRemoteAttempts()` (`storage.js:356-419`) — since the freshly re-namespaced local store has no
  watermark yet (`lastPulledAt: null`), the very next pull fetches the account's **entire**
  `puzzle_attempts` history back down from the server and repopulates it locally under the correct
  namespace. Any attempt that had already landed server-side before the expiry moment comes back.

**What is genuinely, permanently lost or stuck (not recovered by anything that exists today):**
- Any attempt recorded **locally during the expired-session window itself** — `pushAttemptIfPossible`
  no-ops with no session (`storage.js:289-290`), so these rows were only ever local, get tagged
  `'guest'` by the misattribution, and have no server copy for `pullRemoteAttempts()` to restore.
- Any **local-only preference change** (board theme/app mode/input mode) made at any point before
  the migration ran — per this document's §4 finding, `preferences` has no ongoing push path at all
  (only a one-time push at account-creation migration time), so essentially any theme/mode change
  made after the account was first created is local-only and ends up orphaned under `'guest'`,
  invisible to the account, with nothing that pulls preferences back down to notice or recover it.
- Neither of these is recoverable through any path that exists in the shipped app today. The only
  way the stray `'guest'`-tagged data could ever be reunited with the account is if this same user,
  on this same device, later chose **Play as Guest** (inheriting the stray data as if it were normal
  guest continuity) and then ran **Create Account** or a **Merge** into some account — and even then
  only Create Account's existing migration prompt would offer to merge it, and only if the user
  correctly recognizes what's happening and merges it into the right place. Logging back into the
  *original* account (the natural, expected recovery action) does not surface or recover any of it.

**Net answer to the original question:** neither "silently skips and retries with no loss" nor
"throws." **It silently misattributes the legacy data to `'guest'`, permanently (absent a deferred-
marking safeguard not yet designed), on a narrower trigger condition than plain token expiry** (it
requires the refresh call to fail *and* the access token's real expiry to have already passed — the
library's own fallback absorbs ordinary transient refresh hiccups). The account's server-side
source of truth is never damaged, and previously-synced attempts self-heal via the existing pull
mechanism on the user's next login — but any local-only data from the gap (unsynced attempts made
during the dead-session window, and effectively all local preference changes, since those are never
pushed at all outside the one-time migration) is left stranded under `'guest'` with no existing
recovery path.

**Second-device scenario — different device, same account, never had this legacy data locally:**
confirmed explicitly, unaffected. Such a device either (a) is a genuinely fresh install with no
local data of any shape, in which case there is nothing to adopt and it simply starts in its
correctly-namespaced empty state, or (b) independently accumulated its own pre-Option-A legacy data
and needs its own independent one-time adoption pass, run locally on that device the same way — the
adoption step is inherently per-device and local-only, there is no cross-device coordination
involved or required. Either way, that device's actual account history then arrives through the
**already-shipped, already-working `pullRemoteAttempts()` mechanism** (`storage.js:356-419`), which
is confirmed unaffected by any of this: it fetches remote `puzzle_attempts` rows scoped by
`profile_id` (server-side, RLS-enforced) past its local watermark and inserts them into whatever
the local attempts store is at the time it runs — under Option A, that's simply the
now-correctly-namespaced local store for that account, and pull's own logic (dedup by `remoteId`,
watermark advancement) needs no changes to keep working correctly against it.

---

## Addendum (2026-09-10, third pass): The Deferred-Marker Mitigation, Investigated Concretely

Follow-up investigation only — no code changes, no commits, no Supabase writes. The second addendum
above named "defer setting the done marker until a real, confirmed session is observed" as the fix
for the expired-session misattribution risk, but only as a named direction, not a concrete design.
This pass designs it concretely enough to scope directly into a build spec.

### 1. What counts as "confirmed"

**Signal: `supabase.auth.getSession()` resolves with `error === null` and a non-null `session`
object (i.e., `data.session` truthy) — nothing stronger is needed, and this is grounded directly in
the `__loadSession()` behavior already read from source in the second addendum, not a new
assumption.**

The reasoning: `__loadSession()` (`GoTrueClient.js:2496-2579`) only ever returns a non-null session
in three branches — (1) a stored session whose access token isn't yet within the eager expiry
margin, (2) a stored session whose refresh just succeeded, or (3) the "proactive-preserve" fallback,
which itself explicitly checks `accessTokenStillValid = currentSession.expires_at * 1000 >
Date.now()` (line 2562) before returning the old session. **In all three branches, the returned
session's access token is, by the function's own internal invariant, genuinely unexpired at that
exact instant.** So there is no additional expiry check this mitigation needs to layer on top of a
non-null `getSession()` result — checking for non-null-with-no-error already carries that guarantee
for free, because the library itself never hands back a session in a state this mitigation would
need to second-guess.

A stronger signal was considered and rejected: a server round-trip via `getUser()` (GoTrueClient
exposes this — "performs a network request to the Supabase Auth server, so the returned value is
authentic"). This would add cryptographic/server-side confirmation, but it's inconsistent with how
every other part of this codebase already treats "is there a session" — `App.jsx`'s own boot check,
`pushAttemptIfPossible`, and `pullRemoteAttempts` all use plain `getSession()`, never `getUser()`.
Introducing a stronger, network-dependent standard for this one purpose would be an unexplained
inconsistency, adds latency/a network dependency to a path that's supposed to stay fast and
local-first, and isn't needed given the invariant above already holds. **Recommendation: reuse the
exact same `getSession()` non-null/no-error signal already used everywhere else in this file — no
new verification primitive.**

One precision worth stating explicitly: "confirmed" is a property of *this boot's* resolved result,
checked once `sessionStatus` has left the transient `'checking'` state (`App.jsx`'s own state
machine already distinguishes `'checking'` from its resolved outcomes `'valid'`/`'none'`/`'disabled'`
— the adoption routine should key off the same resolved state `App.jsx` already computes, not run a
second, independent `getSession()` call). A resolved `'valid'` state is unambiguously confirmed. A
resolved `'none'` state is a separate, harder question — addressed in full in §3 below, because (as
that section shows) `'none'` is *not* uniformly safe to treat as "confirmed guest."

### 2. Retry behavior across multiple boots — idempotency, traced boot-by-boot

**Direct answer to the question as posed: boot 1 must skip the adoption attempt entirely when
identity isn't confirmed — it is *not* safe to let the full adoption run every time and only gate
the marker.** The act of adoption *is* the write that causes misattribution; gating only a
downstream "done" flag doesn't prevent that write from happening under the wrong identity in the
first place. Concretely, if boot 1 (unconfirmed, `'none'`) were allowed to run the actual
rename/tag-into-current-identity step and only withhold the "done" flag, it would already have
tagged/moved the legacy data into `'guest'` by the time boot 2 (now confirmed, real account) runs —
and by then there is no more untagged legacy data left for boot 2 to find and correctly adopt into
the account. Gating the marker alone doesn't undo boot 1's write; it just means boot 2 harmlessly
(but uselessly) re-runs a check that finds nothing left to do, while the actual misattribution from
boot 1 stands, unrepaired. So the adoption step's *consuming* action (not just its completion
marker) has to be conditioned on confirmation.

**A stronger, simpler design falls out of this once you look at what "the marker" needs to mean:**
rather than a separate boolean "migration done" flag (which introduces exactly the premature-set
risk this whole addendum exists to close), **use the presence or absence of the legacy,
un-namespaced data itself as the idempotency signal.** Concretely:
- For the single-key stores (`profile`, `preferences`, both currently at the bare key `'main'`):
  the adoption step checks whether a record still exists under the *old* bare key. If confirmed,
  it copies that record into the new namespaced key for the current identity and **deletes the old
  bare-key record** as part of the same operation. A later boot's "does legacy data exist" check is
  then trivially `false` — no separate flag needed, and the check is naturally idempotent because
  the source data is consumed exactly once, atomically with the copy.
- For the multi-row `attempts`/`themeStats` stores: the adoption predicate for a given row is "does
  this row have no owner tag at all" (field absent), not "is this row's owner tag different from the
  current identity." That distinction matters: once a row is tagged (with *any* value — `'guest'`
  or a real account id), it permanently drops out of the "needs adoption" set, so re-running the
  full scan on a later boot is a safe no-op for every already-tagged row and only picks up rows that
  somehow still have no tag at all (which, after a single successful confirmed-boot adoption pass,
  is none of them).

This design is self-idempotent by construction and satisfies the requirement directly: **no
attempt row is ever double-counted or duplicated** (tagging annotates a row in place; it never
copies, merges, or re-inserts it, so the total row count and content are invariant no matter how
many boots the migration takes to actually run), and **no theme/preference state is corrupted**
(the single-key copy-then-delete is one atomic operation per store, same transactional shape
`resetAllLocalData()` already uses for all four stores today).

**Traced boot-by-boot, against the narrow edge case from the second addendum** (device has real
legacy data, is logged in to a real account, and this exact boot's session resolves unconfirmed
due to the dead-refresh-token condition):

- **Boot 1 (unconfirmed):** the adoption routine detects legacy data exists, checks confirmation,
  finds it absent, and **skips the consuming step entirely** — no rename, no delete, no tagging.
  Ordinary reads this boot (`getProfile`/`getAllAttempts`/`getPreferences`, all resolving `'guest'`
  as current identity since the session is null) find nothing under the `'guest'` namespace yet
  (nothing has been adopted into it) and return defaults — a real, but *cosmetic and single-boot*,
  regression (rating/theme accuracy/board theme display reset for this one session), clearly weaker
  than the original "permanent misattribution" finding from the second addendum. If the user plays
  as Guest during this boot, any new attempts get written freshly tagged `ownerId: 'guest'` — these
  coexist harmlessly alongside the still-untouched, still-untagged legacy rows in the same physical
  store; nothing about this collides or gets confused with them, because "untagged" and "tagged
  `'guest'`" are different, distinguishable predicate states.
- **Boot 2 (confirmed — either the transient issue passed, or the user explicitly re-authenticated
  via Login):** the adoption routine re-checks, finds the legacy data still fully intact and
  untouched (boot 1 never consumed it), confirmation now holds, and it proceeds: the legacy
  untagged rows and the bare-keyed profile/preferences records are adopted into whichever identity
  is now confirmed. Any rows freshly written during boot 1's guest interlude are untouched (already
  tagged, don't match the adoption predicate) and remain correctly attributed to `'guest'` — they
  are *not* silently folded into the account, which is the correct behavior (a guest interlude
  really was played logged-out; reuniting it with the account, if ever wanted, is exactly what the
  existing Merge/Discard flow is for, not something this migration step should do unprompted).

### 3. Interaction with guest mode

This is where the honest answer is that **a resolved `'none'` cannot, by itself, be treated as
"confirmed guest" — doing so silently reopens the exact misattribution risk this addendum exists to
close, since the narrow edge case *is* a resolved `'none'`.** A genuinely permanent guest and a
temporarily-unconfirmed logged-in device are, from this device's local information at the instant
of first boot, indistinguishable by session state alone. That's not a gap this investigation failed
to close — it's an irreducible fact about what a resolved `'none'` can mean, and the design has to
pick a policy for handling it rather than pretend the ambiguity isn't there.

**A concrete, already-available signal does resolve most of the ambiguity, though, without adding
any new schema or state:** check whether **any row in the device's legacy `attempts` store has a
*raw, un-defaulted* stored `synced` value of exactly `true`.** This has to read the raw IndexedDB
record directly, not go through the existing `getAllAttempts()`/`getRecentAttempts()` helpers —
those apply `withSyncedDefault`'s `attempt.synced ?? true` (`storage.js:174-176`) at read time,
which would incorrectly make ancient, pre-sync-feature (schema v2-era) guest records — which have no
`synced` field at all — look identical to a genuinely-synced row. Read raw: a record with `synced`
field **absent** predates the sync feature entirely and is unambiguous, harmless-to-treat-as-guest
legacy data (the account-sync feature didn't exist when it was written, so it can never be an
account's data). A record with raw `synced === false` is inconclusive (could be guest, could be an
account whose push simply hadn't succeeded yet). A record with raw `synced === true` is strong
positive evidence: `pushAttemptIfPossible` (`storage.js:286-308`) only ever sets this when a real,
working session existed at the moment that row was processed and either inserted successfully or
hit `23505` (already landed) — **a pure guest can never produce this value**, because
`pushAttemptIfPossible` no-ops entirely with no session.

So the concrete policy: **if any legacy attempts row has raw `synced === true`, this device is
provably not a pure guest — do not adopt its legacy data into `'guest'` on an unconfirmed boot,
regardless of how many boots that takes; wait for a confirmed identity (a successful Login, or the
transient issue resolving on its own) before running adoption at all.** If no such row exists (every
row's raw `synced` is `false` or absent), the device's legacy data looks like genuine, never-synced
guest play, and it is safe to adopt into `'guest'` on this very first unconfirmed boot without
further hesitation — there is no realistic account-shaped signal being ignored.

This directly answers the retry-indefinitely concern: **a true guest is never actually stuck in a
deferred state at all** — the `synced === true` check resolves negatively on the very first boot
(no ambiguity found), and adoption proceeds into `'guest'` immediately, consuming the legacy data
and leaving nothing to re-check later. The only population that experiences any deferral is the
narrow one that both (a) has legacy pre-Option-A data, and (b) has at least one raw `synced === true`
row proving a real account was genuinely involved at some point — and even for that population, the
wait ends at the very next successful confirmation (any successful Login, or any boot where the
token refresh happens to succeed), not an unbounded loop.

One residual case worth naming honestly rather than glossing over: an account that was created,
went offline before a single attempt ever successfully pushed *and* before any login/foreground pull
ever completed, and then had its token die before ever reconnecting — this narrow case has no
`synced === true` row to serve as positive evidence, and would be treated (incorrectly) as safe to
adopt into `'guest'`. This is a strictly smaller, rarer sub-case of the original ambiguity (it now
additionally requires *zero* successful sync events ever, not just an unlucky boot), not something
this investigation resolves further — worth recording as a known residual, not an unstated
assumption.

### 4. Verification plan — testing the real-expiry-plus-failed-refresh condition without waiting on it

Two complementary levels, matched to what each is actually good for:

**Level 1 — mock `getSession()` directly, test the adoption logic's reaction, not the library's
internals.** Since `src/lib/supabaseClient.js` exports the one shared client instance every call
site uses, a unit/component test can stub `supabase.auth.getSession` (a spy/mock override on the
exported instance) to resolve `{ data: { session: null }, error: {...} }` directly, bypassing real
token math entirely. This is the right tool for verifying the *application's* behavior given that
input: confirm the adoption step detects legacy data, checks the `synced === true` signal from §3,
and either defers (if positive evidence of a real account exists) or proceeds into `'guest'`
immediately (if not) — all deterministic, fast, no real network or token lifecycle involved. (Note:
this repo's `package.json`/config wasn't inspected for which test runner, if any, is already set up
here — that's a build-time detail to confirm, not assumed by this investigation.)

**Level 2 — exercise the real `__loadSession()` boundary end to end**, matching this codebase's
already-established real-backend Playwright verification pattern (per CLAUDE.md's Test Fixtures
section). Concretely: seed `localStorage`'s auth storage key (`sb-<project-ref>-auth-token`, via
`page.addInitScript`/`page.evaluate` before the app loads) with a crafted session object whose
`expires_at` is already in the past, and use `page.route()` to intercept the Supabase Auth token
endpoint (`.../auth/v1/token?grant_type=refresh_token`) and force it to return an error response
(e.g. a 400 `invalid_grant`) — reproducing "refresh fails and the access token's real expiry has
already passed" without waiting on real wall-clock time. Separately seed IndexedDB (also via
`page.evaluate`, writing directly to the legacy un-namespaced shape) with a legacy-looking attempts
row carrying raw `synced: true`, load the app, and assert: (a) the app shows the launch screen
(session resolved null, matching real `__loadSession()` behavior), (b) the legacy data is left
untouched, not adopted into `'guest'` (confirming the `synced === true` deferral from §3 held), and
(c) a subsequent real Login against a live test account then correctly triggers adoption into that
account's namespace on the next (confirmed) boot.

**Live-write flag:** step (c) above requires a real account to log into — the standing test fixture
(`TEST_FIXTURE_KEEP`, per CLAUDE.md) or a fresh throwaway account. Per the standing live-write rule,
this specific verification step should get its own before-not-after confirmation when build/
verification work actually starts — flagged here now so it isn't a surprise later, not performed as
part of this investigation.

### 5. Scope confirmation

**Additive to the Option A design already recommended — this refines one piece of scope the first
addendum already flagged as new (the one-time legacy-adoption routine), it does not reopen or
change anything already decided:**

- The namespacing key scheme itself (`` `profile:${identity}` ``/`'guest'` sentinel, `ownerId`
  tagging on attempts rows) is untouched.
- The auto-resolving identity mechanism for ordinary (non-migration) reads/writes — `storage.js`
  calling `supabase.auth.getSession()` internally, gated behind `ACCOUNT_SYNC_ENABLED` — is
  untouched.
- The two required `LaunchOverlay.jsx` fixes from the first addendum (the `handleCreateAccount`
  ordering fix; the explicit guest-namespace override needed by `migrateGuestDataToAccount`/
  `handleDiscard`) are untouched and still required — they address a different failure mode
  (identity resolving to the *wrong active* account mid-migration-flow) than this addendum's
  concern (identity resolving to *no* account when one should exist), and neither fix substitutes
  for the other.
- `recompute_stats()`, the watermark logic, and the migration `remoteId` reuse logic (§3 of the
  original findings) remain confirmed untouched by this addendum, for the same reasons already
  established there.

What this addendum adds as genuinely new, additional scope on top of what the first addendum
already named (it does not shrink or replace that estimate, it sharpens one part of it):
- The adoption routine needs an explicit confirmation gate before its consuming (rename/tag/delete)
  step is allowed to run — not present in the original "one-time write-back, mirrors
  `resetAllLocalData`'s shape" framing from the first pass, which didn't yet account for boot-time
  session ambiguity at all.
- The `synced === true`-on-a-raw-read check (§3) is new application logic, but reads fields the
  schema already has (`synced`) — no new field, no schema change, no `DB_VERSION` bump. Purely
  additive.
- No change to the recommendation itself: Option A remains the recommended path from §5 of the
  original findings. This addendum narrows how its already-acknowledged migration-routine scope
  should be built, not whether Option A is still the right choice.

---

## Addendum (2026-09-11, fourth pass): Is `synced === true` Actually Guest-Unreachable? Traced, Not Reasoned

Follow-up investigation only — no code changes, no commits, no Supabase writes. The third addendum
built its confirmed-vs-guest signal on the claim that a raw `synced === true` value is proof a real
session was involved. This pass verifies that claim directly against the code and git history,
rather than continuing to reason about it from the surrounding design comments.

**Verdict up front: confirmed clean. There is no guest-reachable path anywhere in the current
codebase, or at any point in its history, that sets or defaults an attempt record's `synced` field
to `true` without a live, active session already having been required to reach that code.**

### Every place `synced` is ever set to `true`, traced individually

A repo-wide search (`grep -rn synced src/`) turns up exactly three places a literal `true` is
written, plus one read-time default. Each is traced below to its actual reachability, not its
docstring's stated intent.

**1. `markAttemptsSynced` (`storage.js:251-264`), `store.put({ ...existing, ..., synced: true })`
at line 258.** The function itself has no internal session/account guard — it will unconditionally
mark whatever `id` it's given. So the guarantee has to come from its callers, and a full trace of
every call site (two, confirmed by `grep -n "markAttemptsSynced\|markAttemptSynced" src/`) shows
both are gated:
   - `markAttemptSynced` (singular wrapper, `storage.js:266-268`) is called from exactly one place:
     `pushAttemptIfPossible` (`storage.js:305`), and only *after* that function's own two early
     guards have already passed — `if (!ACCOUNT_SYNC_ENABLED) return` (line 287) and
     `if (!session) return` (line 290) — and only after the `puzzle_attempts` insert at line 292
     either succeeded or hit `23505`. There is no branch in `pushAttemptIfPossible` that reaches
     `markAttemptSynced` without a session having already been read as non-null two lines earlier.
     **Not guest-reachable.**
   - `LaunchOverlay.jsx:89`, inside `migrateGuestDataToAccount(userId)`, called only after
     `supabase.from('puzzle_attempts').insert(rows)` has already succeeded (lines 86-87: an error
     there throws before reaching line 89). `migrateGuestDataToAccount` itself is only ever invoked
     from `handleMerge` (`LaunchOverlay.jsx:247`), which is only reachable from the
     `MIGRATION_PROMPT` view, which is only ever shown *after* `handleCreateAccount` has already
     called `supabase.auth.setSession(data.session)` successfully for a **newly created account**
     (`LaunchOverlay.jsx:219`). So this path, too, requires an active, real session to already exist
     before it can run. It's worth being precise about what this path actually represents: it does
     mark a *previously-guest-owned* row `synced: true` — but only at the exact moment that data's
     owner explicitly, interactively converts from guest to a real account via Merge. A person who
     never creates an account and never logs in has no way to reach `handleMerge` at all (it isn't
     rendered until a session already exists), so this is not a counterexample to "a permanent guest
     can never produce `synced: true`" — it's the intended identity-transition event itself, gated
     the same way as everything else here. **Not guest-reachable in the sense that matters**: no
     *still-guest* device can trigger it.

**2. `pullRemoteAttempts` (`storage.js:395`), `store.add({ ..., synced: true, ... })` when inserting
a freshly pulled remote row.** This entire function returns immediately, before touching
`STORE_ATTEMPTS` at all, on two guards: `if (!ACCOUNT_SYNC_ENABLED) return { pulled: 0 }` and
`const { data: { session } } = await supabase.auth.getSession(); if (!session) return { pulled: 0 }`
(`storage.js:357-360`). The `store.add(...)` with `synced: true` is dozens of lines further down,
reachable only after a successful, session-scoped Supabase query against `puzzle_attempts`
(`storage.js:365-369`, filtered `.eq('profile_id', session.user.id)`) has already returned data.
**Not guest-reachable** — there is no session-less branch that reaches this line.

**3. `recordAttempt` (`storage.js:435-478`), the only place a *brand-new* attempt record is
constructed.** The literal object built at line ~458-460 is
`{ puzzleId, themes, solved, hintUsed: !!hintUsed, ratingDelta, timeTakenMs, at: Date.now(), synced:
false, remoteId }` — **hardcoded `false`, unconditionally, with no login-state or
`ACCOUNT_SYNC_ENABLED` branch anywhere in its construction.** This directly answers the second part
of the question ("could the default value on record creation itself be `true` under any guest-mode
path"): no — every new record, guest or account, flag on or off, is created with `synced: false`.
There is no code path — guest or otherwise — where a newly-created record's default is `true`.

**4. `withSyncedDefault` (`storage.js:174-176`), `{ ...attempt, synced: attempt.synced ?? true }`.**
This is the one place `true` appears without an account gate — but it is a **read-time
transform, not a write.** Traced through its three call sites (`getRecentAttempts`,
`getAllAttempts`, `getUnsyncedAttempts` — all read-only, `getAll()` followed by `.map(...)`, none of
which call `store.put`/`store.add`), it only ever affects the *value returned to the caller in
memory*; the underlying IndexedDB record is never rewritten by this function. This is exactly why
the third addendum's design specified checking the **raw stored record**, bypassing this default —
and this trace confirms that specification was necessary and sufficient: without bypassing it, a
naive read *would* see `true` for records this default silently backfilled, but the actual persisted
data on disk is untouched by it.

### Could the default ever have been different historically? Checked against git, not assumed

`synced` is not a field that existed from the app's original design and was later reinterpreted —
it was introduced whole, in one commit, well after the original guest-only puzzle engine:

- `git log --oneline -- src/utils/storage.js` shows the full history of this file. The earliest
  commit touching it (`b2e7db5`, "Add puzzle engine, coach layer, and rewired UI") explicitly
  describes the attempts store as "persist rating/streak/per-theme accuracy to IndexedDB
  (storage.js) **with no sync or auth**" — confirming there was no sync-related concept, under any
  name, at the field's origin.
- `synced` first appears in `6ee7e94` ("feat: add synced flag and push logic for puzzle_attempts",
  Sept 8, 2026) — traced directly via `git show 6ee7e94 -- src/utils/storage.js`. In that very first
  commit, `withSyncedDefault` is already exactly `attempt.synced ?? true`, `recordAttempt`'s
  creation-time literal is already exactly `synced: false`, and the lone `markAttemptSynced` (the
  single-entry predecessor of today's `markAttemptsSynced`) already only fires from inside
  `pushAttemptIfPossible`'s session-gated success branch. There was no earlier or intermediate
  shape where the creation-time default was `true`, or where marking-synced was reachable without a
  session — the design was gated correctly from its very first commit, not fixed up later.
- The two subsequent commits that touch `synced` (`9db67b4`, adding `pullRemoteAttempts`; `27b2794`,
  unifying the migration path onto `recompute_stats()` and generalizing `markAttemptSynced` into
  `markAttemptsSynced`) were both checked via `git show <sha> -- src/utils/storage.js
  src/components/LaunchOverlay.jsx`: neither changes the creation-time default, and neither
  introduces a new, less-gated call site — `9db67b4` adds the session-gated pull-insert path (item 2
  above), and `27b2794` only changes `markAttemptSynced` to accept a batch of entries and to also
  persist a backfilled `remoteId`, without changing what gates it (still only called from
  `pushAttemptIfPossible`'s post-session-check success branch and from `migrateGuestDataToAccount`,
  itself gated as described above).
- Checked `supabase/` (migrations and Edge Functions) for any server-side notion of `synced` that
  could interact with this client-local field: none exists (`grep -rn -i synced supabase/` returns
  no matches). `synced` is, and has only ever been, a purely client-local IndexedDB field with no
  server-side counterpart — there is no additional surface there to check.

### Plain conclusion

**Confirmed clean.** Every place `synced` is ever written to `true` — `markAttemptsSynced` (via
both of its two call sites), and `pullRemoteAttempts`'s pulled-row insert — sits behind a
`supabase.auth.getSession()` check (direct or, for the `LaunchOverlay.jsx` Merge path, indirect via
requiring an already-established session before that UI is even reachable) that returns early on no
session, with no guest-reachable branch around any of them. The creation-time default
(`recordAttempt`) is unconditionally `false`, for guests and accounts alike, with no login-state
branch in its construction at all. The one unguarded `?? true` (`withSyncedDefault`) is a read-time
display default that never writes back to the store, which is exactly why the third addendum's
mitigation design specified reading the raw stored value rather than any of the existing
`get*Attempts()` helpers. Git history confirms this was the design from the field's first commit
(`6ee7e94`), not a later correction — there is no historical shape of this codebase in which a
guest could have produced a raw `synced === true` record. The third addendum's deferred-marker
signal stands as load-bearing: a raw `synced === true` row on a device is reliable, unconditional
proof that a real, authenticated session was active at some point on that device.
