# Investigation: Theme/Preferences Ongoing Sync

Status: **Findings only — no code changes, no commits, no writes to Supabase (local or
production).** Builds directly on top of `docs/specs/storage-partitioning-investigation.md`
(all findings + four addenda) and the resulting 4-commit build, per CLAUDE.md's "Storage
partitioning" section — read in full before starting this pass, per the prompt.
Date: 2026-09-11

---

## 1. Current State, Precisely

### Every preference field, current shape (post-partitioning)

Confirmed directly from `src/utils/storage.js` (current, post-4-commit-build):

```js
const DEFAULT_PREFERENCES = {
  appMode: null,       // null until first OS-detection; then persisted and never re-detected
  boardTheme: 'tournament',
  inputMode: 'drag',
  lastPulledAt: null,  // ISO string watermark for pullRemoteAttempts; null means "never pulled"
}
```

Four fields, only three of which are genuinely user/system-facing preferences (`appMode`,
`boardTheme`, `inputMode`); `lastPulledAt` is `pullRemoteAttempts`'s own local-only bookkeeping
watermark for **attempts** sync, living in the same record for convenience, not a preference at
all — this distinction matters throughout this investigation (see §2).

Storage shape post-partitioning (Commit 1): `STORE_PREFERENCES` is an out-of-line store keyed
directly by identity — `getPreferencesFor(identity)`/`getPreferences({ identity } = {})` (auto-
resolves via `resolveIdentity()` if no override passed) /`savePreferences(preferences)` (always
auto-resolves, no override param exists — confirmed by re-reading the current file; nothing calls
it with an explicit identity today, unlike `getAllAttempts`/`resetAllLocalData`/
`markAttemptsSynced`). No `DB_VERSION` bump, consistent with the rest of that build.

### Every write path, enumerated (confirmed via repo-wide grep, not assumed)

`grep -rn "savePreferences(\|getPreferences(" src/` turns up exactly these real (non-test) call
sites:

| Call site | File | Trigger | What changes |
|---|---|---|---|
| Boot effect, one-time OS-mode detection | `App.jsx:131-137` | First-ever boot, `prefs.appMode === null` | `appMode` only |
| `toggleAppMode` | `App.jsx:224-231` | User clicks the sun/moon toggle (`Header.jsx`) | `appMode` |
| `selectBoardTheme` | `App.jsx:233-237` | User picks a board theme (`SettingsPanel.jsx`) | `boardTheme` |
| `selectInputMode` | `App.jsx:239-242` | User picks drag/tap (`SettingsPanel.jsx`) | `inputMode` |
| `pullRemoteAttempts`'s watermark write | `storage.js:536` | Every successful attempts pull with ≥1 row | `lastPulledAt` **only** — rewrites the whole record via spread, but the only field that actually changes is the watermark |
| Migration-time push | `LaunchOverlay.jsx:111-121` (`migrateGuestDataToAccount`) | Account creation, guest history exists | Reads local (`GUEST_IDENTITY`-scoped), pushes to Supabase once |

`SettingsPanel.jsx` itself is confirmed purely presentational — it calls `onSelectBoardTheme`/
`onSelectInputMode` **props**, owned entirely by `App.jsx`; it never imports or calls `storage.js`
directly. This matters for §6's scope-creep question: every real write path is already
`App.jsx`/`storage.js` code, not UI code.

### The one-time migration-time push, confirmed exactly

`LaunchOverlay.jsx:96-121` (`migrateGuestDataToAccount`, now using the Commit-2 `GUEST_IDENTITY`
override):

```js
const prefs = await getPreferences({ identity: GUEST_IDENTITY })
const { error: preferencesError } = await supabase.from('preferences').upsert(
  { profile_id: userId, app_mode: prefs.appMode, board_theme: prefs.boardTheme, input_mode: prefs.inputMode },
  { onConflict: 'profile_id' },
)
```

This is the **only** place `preferences` is ever written to Supabase anywhere in this codebase —
confirmed via `grep -rn "from('preferences')" src/`: exactly one match, this one. No pull path
exists at all — confirmed via the same style of search: nothing in `storage.js` or elsewhere ever
issues a `select` against `preferences`.

### Schema and RLS, confirmed from the actual migration SQL

`supabase/migrations/20260819140000_init_schema.sql:91-99`:

```sql
create table if not exists public.preferences (
  profile_id   uuid primary key references public.profiles (id) on delete cascade,
  app_mode     text,
  board_theme  text,
  input_mode   text,
  updated_at   timestamptz not null default now()
);
alter table public.preferences enable row level security;
```

`profile_id` is the **primary key** — not just unique — genuinely one row per account, enforced at
the database level, not just by convention. `updated_at` has a server-set trigger
(`preferences_set_updated_at`, `before insert or update`, same `set_updated_at()` function
`puzzle_attempts` uses) — a client can never supply its own value, exactly mirroring
`puzzle_attempts`'s own LWW timestamp design. RLS (`20260819140001_rls_policies.sql:54-59`):
`preferences_owner_only`, `for all`, `to authenticated`, `using/with check (auth.uid() =
profile_id)` — identical shape to every other per-account table. Grants
(`20260822203000_grant_table_privileges.sql:23-30`): `select, insert, update, delete` to `anon,
authenticated, service_role`, with RLS reducing `anon`'s effective access to zero, same posture as
every other table.

**No schema change of any kind is needed for the design recommended below** — every field this
investigation's push/pull design needs already exists on this table.

**Already-locked design decision, not new** — `Sharpin_Spec_AccountSync.md:78`: *"Preferences also
sync via per-record LWW on the single `preferences` row per profile — the more recent device-side
change wins."* §3 below confirms this holds, with one precision the original spec text didn't
spell out.

---

## 2. Push Design

### Recommendation: immediate direct write, not debounced — stated concretely, not hedged

The prompt asks whether preferences should follow `puzzle_attempts`' exact pattern or whether the
single-row-per-account shape calls for something different (e.g. debounced upsert). Concrete
answer: **immediate direct write on every change, no debounce**, for two independent reasons:

1. **The UI interaction cadence doesn't produce the volume debouncing exists to solve.**
   `SettingsPanel.jsx`'s `OptionButton` clicks are discrete, deliberate, one-shot selections (pick
   a board theme, done) — not a continuous input (a drag-slider, a per-keystroke text field) that
   fires many times a second. A user might click through several themes in a row while browsing
   options, but at human click cadence (hundreds of ms apart at the fastest), not machine speed.
2. **A single-row upsert makes rapid repeated pushes cheap and harmless, unlike debouncing's actual
   cost.** Each push simply overwrites the same one row; there's no accumulation, no duplicate-row
   risk, nothing to coalesce. Debouncing would add real complexity (a timer, cancellation on
   unmount, a "did the debounced write actually land before the tab closed" edge case) to solve a
   volume problem that doesn't exist at this UI's actual interaction rate.

Reuse the exact upsert shape already proven live in `migrateGuestDataToAccount`
(`supabase.from('preferences').upsert({...}, { onConflict: 'profile_id' })`) for the new ongoing
push, rather than inventing a new write shape.

### `remoteId`/idempotency pattern — confirmed not relevant here, precisely why

The prompt asks to confirm this directly rather than assume it transfers. It doesn't, and the
reason is structural, not incidental: `remoteId` exists on `puzzle_attempts` because that table is
**append-only** — every attempt is a new row, and a retried push needs a stable id to make a
duplicate-insert collapse into a no-op (`23505`-as-success) rather than create a second row.
`preferences` has no append-only dimension at all — `profile_id` **is** the primary key, so
`upsert(..., { onConflict: 'profile_id' })` is *already* naturally idempotent: retrying the exact
same upsert twice produces the exact same single row both times, no collision handling, no
generated id, no dedup logic needed anywhere. This isn't a smaller version of the attempts pattern
— it's a different problem shape that the attempts pattern doesn't apply to at all.

### The one write path that must NOT trigger a push

`pullRemoteAttempts`'s own watermark write (`storage.js:536`,
`savePreferences({ ...prefs, lastPulledAt: maxUpdatedAt })`) goes through the exact same
`savePreferences()` function every real preference change goes through. If a naive design made
`savePreferences` itself push on every call, this watermark-only write would also trigger a push —
wastefully (an extra round-trip on every attempts pull that finds new rows, for a preference value
that didn't actually change), and incorrectly in spirit (`lastPulledAt` has no corresponding
server column at all — it would either be silently dropped by an upsert that only names the three
real columns, or need to be explicitly excluded, either way signaling that push doesn't belong at
this call site conceptually).

**Concrete design to avoid this, consistent with existing conventions:** don't put the push inside
`savePreferences` itself. Instead, introduce one new function that the three real user/system-
facing call sites go through — e.g. `updatePreferences(partial)` — that does the existing
read-merge-write internally *and* fires the push, mirroring `recordAttempt`'s own shape (a single
storage.js function doing local write + fire-and-forget push, `storage.js:561-605`) more closely
than three independent App.jsx call sites each separately calling `getPreferences().then(...)`
today:

```js
// Illustrative shape, not a build spec
export async function updatePreferences(partial) {
  const identity = await resolveIdentity()
  const prefs = { ...(await getPreferencesFor(identity)), ...partial, synced: false }
  await savePreferencesFor(prefs, identity)
  pushPreferencesIfPossible(prefs).catch(() => {}) // fire-and-forget, mirrors pushAttemptIfPossible
  return prefs
}
```

`getPreferences()`/`savePreferences()` themselves stay exactly as they are and remain the right
tool for `pullRemoteAttempts`'s own internal watermark bookkeeping, which should keep calling them
directly, not `updatePreferences` — this is precisely why keeping both is correct rather than
having one replace the other. `App.jsx`'s `toggleAppMode`/`selectBoardTheme`/`selectInputMode`
would call `updatePreferences({ appMode: next })` etc. instead of their current two-step
`getPreferences().then((prefs) => savePreferences({ ...prefs, appMode: next }))` — a change to
what `App.jsx` calls, not to anything `SettingsPanel.jsx` renders or how it behaves (see §6).

### Why a local `synced`-equivalent flag is structurally required here, not just imitative

Traced through to its actual necessity in §3 below (this isn't decided independently of pull — the
two are coupled for preferences in a way they aren't for attempts): a plain "always push
immediately, no flag" design would work fine in isolation, but combined with any pull step it
creates a real clobber risk specific to preferences' single-mutable-row shape. See §3 for the
concrete trace; the conclusion feeds back here: `updatePreferences` sets a local `synced: false` on
write (mirroring `recordAttempt`'s own `synced: false` at creation), and the push, on success, sets
it back to `true` alongside recording the server's returned `updated_at` locally (see §3's
`preferencesUpdatedAt` field). Records that predate this feature default to `synced: true` on read
(same `?? true` defaulting convention as `withSyncedDefault`), for the same reason attempts' own
default does: a pre-existing record should never retroactively believe it has a pending change to
push.

---

## 3. Pull Design

### When to pull

**Fold into the existing `runSyncSequence` in `App.jsx` (`App.jsx:180-195`), riding the exact same
login + foreground/resume triggers and the same `syncInFlightRef` mutex — no separate hook.**
Preferences pull is a single-row fetch, cheaper than the attempts pull it would sit alongside, and
both triggers (`sessionStatus` transitioning to `'valid'`; the Page Visibility listener) already
exist specifically to catch "this device's local state might be stale relative to the server" —
exactly the condition preferences pull needs to react to as well. Building a second, parallel
Page-Visibility listener just for preferences would duplicate machinery that already does the right
job.

### Conflict handling — traced concretely, not assumed to be a non-issue

The prompt asks to state this clearly rather than assume the single-row model makes it moot. **It
does not make it moot — it changes the risk from "none" (attempts) to "a specific, real clobber
risk that needs a specific ordering fix,"** for a structural reason worth spelling out precisely:

`pullRemoteAttempts`'s existing pull-then-flush ordering (`runSyncSequence`:
`pullRemoteAttempts() → flushUnsyncedAttempts() → recompute_stats()`) is safe for attempts
specifically *because* attempts are append-only rows, deduplicated by `remoteId` — pulling remote
rows down can never overwrite or destroy a locally-pending unsynced row; they're structurally
independent rows in the same store. **Preferences has no such independence: pull and a locally-
pending unsynced change target the exact same single record.** If preferences pull followed
attempts' own pull-then-push order and pull always applied a newer-looking server value, it would
silently clobber a local edit that just hasn't been pushed yet (e.g., offline, or a request still
in flight) — the local edit is lost, not merely delayed, because there is nothing else in the
record to distinguish "stale, safe to overwrite" from "pending, must not be overwritten" once pull
has already written over it.

**Concrete resolution: the two steps must be mutually exclusive branches, not a fixed sequence —
and when they do run in sequence, push must come before pull, the opposite of attempts' order:**

- **If the local record has `synced: false`** (a real pending local edit): push first. On success,
  mark `synced: true` locally and record the server-returned `updated_at` (via the upsert's own
  `.select()`, no extra round-trip) as a new local field, e.g. `preferencesUpdatedAt` — **do not**
  reuse `lastPulledAt` for this; that field is attempts' own watermark, and conflating the two
  risks breaking attempts' pull logic, which already reads/writes it through this same record. Skip
  pull entirely for this trigger — a pull immediately after would just re-fetch the value this
  device itself just wrote. If push fails (offline), do not pull either — leave `synced: false` for
  the next trigger to retry; pulling now risks exactly the clobber this ordering exists to avoid.
- **If the local record has `synced: true`** (no pending local edit): nothing to protect — pull
  first (only step needed), compare the server row's `updated_at` against the local
  `preferencesUpdatedAt`, and apply the server's `appMode`/`boardTheme`/`inputMode` locally (updating
  `preferencesUpdatedAt` to match) only if the server's value is newer. This is the ordinary case
  (most logins/foregrounds touch nothing locally) and needs no special handling beyond a plain
  fetch-and-compare — no watermark-with-dedup machinery, confirming the prior investigation's own
  §4 note that preferences' pull is architecturally simpler than attempts' in exactly this respect.

This resolves the already-locked LWW policy ("more recent device-side change wins") correctly for
both directions — a genuinely more-recent local edit reaches the server before anything can
overwrite it; a genuinely more-recent server-side change (from another device) is picked up
whenever this device has nothing of its own pending.

### One more concrete interaction worth flagging for whoever builds this

`migrateGuestDataToAccount`'s existing one-time push doesn't currently write back
`preferencesUpdatedAt`/`synced` locally the way `markAttemptsSynced` already does for the attempts
side of that same migration (backfilling `remoteId`/`synced` after the attempts insert,
`LaunchOverlay.jsx:94-104`). Without an equivalent backfill for preferences, the very first ordinary
sync trigger after account creation would see `synced: false` (or whatever the post-migration local
shape defaults to) and immediately re-push — harmless (idempotent, same values) but wasteful and
worth closing in the same pass rather than leaving as a small rough edge.

---

## 4. Interaction With Last Session's Build

**Confirmed additive — no changes needed to `adoptLegacyDataIfSafe`, the namespace-by-identity
model, or anything the `usePuzzleEngine` blocking precondition touches. Traced concretely, not
asserted:**

- **`adoptLegacyDataIfSafe`** (`storage.js:740-788`) copies whatever object is currently stored
  under the legacy bare key wholesale (`t.objectStore(STORE_PREFERENCES).put(legacyPreferences,
  identity)`) — it has no dependency on the preferences record's exact field shape. Adding
  `preferencesUpdatedAt`/`synced` fields to that shape needs no change here, for the same reason
  `DEFAULT_PREFERENCES`'s own spread-merge (`{ ...DEFAULT_PREFERENCES, ...result }`) already
  tolerates an older-shaped record missing newer fields. A legacy (pre-partitioning) preferences
  record adopted this way would read back with `synced` defaulting to `true` (nothing pending) —
  correct, since a record that predates this sync feature entirely was never anyone's "unpushed
  change" to begin with.
- **The namespace-by-identity model** is already exactly what this design builds on top of —
  `resolveIdentity()`, `GUEST_IDENTITY`, the existing `getPreferences`/`savePreferences` primitives
  — reused as-is, with one new higher-level function (`updatePreferences`) added alongside them, not
  replacing or modifying them.
- **The `usePuzzleEngine` blocking precondition** (CLAUDE.md, the 🚩 section) is about
  `usePuzzleEngine.js`'s `loadPuzzle`/`commitAttempt` racing `App.jsx`'s boot/adoption effect for
  the **profile** (rating) record specifically — entirely separate code, entirely separate store.
  This build touches `App.jsx` and `storage.js`'s preferences functions only; it shares no call
  path with `usePuzzleEngine.js` at all. Per the instruction accompanying this investigation, that
  code was not touched or examined for changes in this pass.
- **`resolveIdentity()`/`GUEST_IDENTITY` reusable without modification** — confirmed; every
  storage.js addition sketched above (§2, §3) would call the existing `resolveIdentity()` exactly
  the way `recordAttempt`/`pushAttemptIfPossible`/`pullRemoteAttempts` already do.

**One real (but narrow) interaction worth naming precisely, not a blocker:** the boot effect's own
`getPreferences()` read (`App.jsx:131`, to set initial `appMode`/`boardTheme`/`inputMode` React
state) runs and resolves *before* `runSyncSequence`'s new preferences-pull step gets a chance to
run (that's a separate, later-firing effect). On a fresh login to a device whose local preferences
are stale or default, this means a brief "flash of the wrong theme" between first paint and the
pull completing — the same local-first, eventually-consistent pattern already accepted for
rating/streak display elsewhere in this app (which also shows local-then-eventually-synced values
rather than blocking on a pull). Flagging this as an expected, cosmetic characteristic consistent
with the rest of the system's existing design, not a new problem this build introduces.

---

## 5. Verification Plan

### Maximum verifiable slice today, without logout

**Two independent Login sessions on the same account, in two separate browser contexts** (two
different browsers, or a normal window + an incognito/private window — anything that gives two
genuinely separate `localStorage`/IndexedDB origins) — mirroring the same pattern already available
for verifying attempts' cross-device pull, and not blocked on logout existing at all, since it uses
**Login** (already shipped, already working) rather than a single-context logout→relogin cycle:

1. **Context A**: Login via the 4-move sequence to the account being used for verification (the
   existing `TEST_FIXTURE_KEEP` account per CLAUDE.md, or a fresh throwaway — flagged as a live-write
   step below). Change board theme to something distinctive (e.g. "Wood"). Confirm the push
   succeeded (the server's `preferences.updated_at` for that row advances, and `board_theme` reads
   back as `'wood'`).
2. **Context B**: Login via the same 4-move sequence to the same account, in the separate browser
   context — a device that has never locally selected any theme. On login, the pull step (per §3)
   should fetch the server's current row and apply `board_theme: 'wood'` locally, visibly changing
   Context B's board theme despite it never being chosen there.
3. Reverse the direction (change theme in B, bring A back to foreground or re-trigger its own
   pull) to confirm the foreground/resume trigger also picks up a change made by a different
   device while this one was inactive — again, no logout involved, just alternating which context
   is "active."

This directly and fully exercises the actual backlog item — **cross-device** board theme
inheritance — end to end.

### What remains genuinely unverifiable until logout exists — stated precisely, not glossed over

**Only the same-device logout→relogin round trip specifically** — confirming that logging out and
back in *on one device* doesn't lose or corrupt that device's own preferences across the logout
boundary. That is a logout-correctness question, not a cross-device-sync question, and depends on
logout's own future implementation (per CLAUDE.md's own forward-dependency note on the adoption
routine, logout doesn't exist yet at all). **This investigation's scope is sufficient to make the
"board theme inheritance" backlog item's cross-device claim fully verifiable and meaningful today**
via the two-context approach above — the backlog item was never actually about the logout round
trip specifically; that's a narrower, separate check that stays blocked regardless of how well this
build is verified.

### Live-write flag

Per the standing rule, stated explicitly rather than glossed over: the verification scenario above
requires real writes against a live Supabase project (the `preferences` table, via either the
existing `TEST_FIXTURE_KEEP` account or a fresh throwaway one). This is out of scope for this
investigation-only pass and needs its own before-not-after confirmation when build work starts, per
the same standing rule every prior investigation in this chain has flagged the same way.

---

## 6. Risk and Scope

### Production Supabase / schema change

**None needed.** Confirmed directly against the actual migration SQL (§1): `profile_id`,
`app_mode`, `board_theme`, `input_mode`, and the server-set `updated_at` already exist and already
have the right RLS/grants for everything this design needs — push is a plain upsert against columns
that already exist; pull is a plain select-and-compare against `updated_at`, which already has its
own server-set trigger. The only new state this design introduces (`preferencesUpdatedAt`, `synced`)
is local-only, inside the existing `preferences` IndexedDB store, no server-side counterpart needed.
The one thing that *does* require a live write is verification itself (§5), flagged separately and
explicitly, not bundled into "no schema change needed."

### Scope-creep risk into Settings UI (Backlog #3) — confirmed clean

This build is sync plumbing only. Every real preference write path already funnels through
`App.jsx`+`storage.js` (§1's table) — `SettingsPanel.jsx` is confirmed purely presentational,
calling only `onSelectBoardTheme`/`onSelectInputMode` props it's handed, never `storage.js`
directly. The `updatePreferences` consolidation sketched in §2 changes what `App.jsx`'s three
handlers *call*, not what `SettingsPanel.jsx` *renders* or how any button behaves from the user's
side — zero markup changes, zero new UI elements, no Account-section reorg. If whoever builds this
finds themselves touching `SettingsPanel.jsx`'s JSX at all, that's a signal the build has drifted
outside this investigation's intended scope.

---

## Addendum (2026-09-11, follow-up pass): The Push-In-Flight / Foreground-Pull Race, Traced

Follow-up investigation only — no code changes, no commits, no Supabase writes. §3's recommended
branch design (push-if-unsynced, else pull-if-newer) was proposed as the fix for the clobber risk;
this pass traces the narrower window the mutual-exclusivity check itself creates — a local change
sets `synced: false`, and before that specific push resolves, a foreground/resume trigger fires the
branch-check again. Traced against the actual code paths involved (the existing `syncInFlightRef`
mutex in `App.jsx`, and `pushAttemptIfPossible`'s already-shipped, already-proven shape that
§2's `pushPreferencesIfPossible` was explicitly modeled on), not reasoned about from the design's
intent.

### Can the branch-check observe a stale (already-`true`) `synced` value while a change is pending?

**No — traced through every mechanism that could cause this, none apply, provided one specific
implementation detail from §2/§3 is preserved.**

- **Read/write ordering**: `updatePreferences`'s local write (`await savePreferencesFor(prefs,
  identity)`, setting `synced: false`) is *awaited* — it fully commits (`t.oncomplete` fires)
  before `updatePreferences` returns and before the fire-and-forget
  `pushPreferencesIfPossible(prefs).catch(() => {})` call even starts. JavaScript's single-threaded
  execution model means no other code — including a foreground event's listener — can run *during*
  that awaited write; it can only run after `updatePreferences` has already yielded control back,
  by which point the `false` write has already committed. There is no window between "user changed
  a preference" and "IndexedDB reflects `synced: false`" that a concurrent read could land inside.
- **Stale closure**: not applicable *as designed* — every check in this codebase (`getPreferencesFor`,
  `getPreferences`) does a fresh `store.get(identity)` read each call; nothing caches a `prefs`
  object across calls anywhere in `storage.js` today. This is worth stating as a **design
  requirement to preserve**, not just an assumption that happens to hold: if a future
  implementation instead threaded a single `prefs` variable captured once and reused across both
  the push call and a later pull-branch check, *that* would reintroduce exactly this risk. The
  fix traces cleanly only because each check is expected to re-read fresh.
- **The scenario as posed** (`synced` already `false`, push in flight, foreground pull fires) is
  therefore not a stale-read problem at all — by the time the foreground trigger's branch-check
  runs, `synced: false` is the actual, currently-committed value, not a stale one.

### Does the pull branch correctly stay deferred until the push resolves one way or another?

**Yes — traced against the exact success/failure shape §2 modeled `pushPreferencesIfPossible` on.**
`pushAttemptIfPossible` (`storage.js:406-428`, already shipped and live-verified per CLAUDE.md's
six-commit ongoing-sync build) only ever flips its local flag to `true` in the success branch
(`if (!error || error.code === '23505') { await markAttemptSynced(...) }`); on any other error it
explicitly does nothing (`// Any other error: leave synced:false`), and a slow/hanging request
simply hasn't reached either branch yet. `pushPreferencesIfPossible`, modeled on this exact shape,
inherits the same guarantee: `synced` stays `false` for the *entire* duration a push is in flight —
slow network, silent failure, or outright timeout all leave it `false` — and only a confirmed
success response flips it. So a concurrent foreground-triggered branch-check, at any point during
that window, reads `false` and correctly takes the push branch (not pull) every time — it cannot
"start pulling anyway under some condition," because nothing in this design has a code path that
sets `synced: true` speculatively or ahead of confirmation.

### Is the window fully closed by the branch design alone, or does it need an explicit mutex?

**Split answer, stated plainly rather than hedged — correctness: yes, closed by the branch design
alone. Redundancy: no, the existing mutex does not cover this specific overlap, and closing that
would need an explicit guard.**

- **Correctness (no clobber, no wrong branch ever taken): fully closed without any new mutex.**
  Traced above — the flag is always read fresh, and it only ever transitions `false → true` on
  confirmed push success. A concurrent pull can never mistake an in-flight push for "nothing
  pending" and overwrite it.
- **Redundancy (does the *same* work happen twice, wastefully): NOT closed by the branch design
  alone, and the existing `syncInFlightRef` mutex does not save it.** The reason is structural, not
  an oversight: `syncInFlightRef` guards `runSyncSequence`'s *own* body
  (`App.jsx:180-195` — `if (syncInFlightRef.current) return; syncInFlightRef.current = true; try {
  ... } finally { ... }`), preventing two *foreground/login-triggered* sequences from overlapping
  each other. But `updatePreferences`'s push is fire-and-forget, called directly from the UI click
  handler, **outside** `runSyncSequence` entirely — this deliberately mirrors `recordAttempt`'s own
  already-shipped shape (`pushAttemptIfPossible(...).catch(() => {})`, also fire-and-forget, also
  outside the mutex). So: if a foreground/resume event fires while that click-triggered push is
  still in flight, `runSyncSequence` runs (the mutex has nothing else in flight to block it against
  — its *own* previous invocation, if any, has already finished), reaches its own preferences
  branch-check step, reads the still-`false` flag, and correctly-but-redundantly issues a *second*,
  concurrent push of the same (or, if another edit landed in between, a newer) local state. Not a
  data-loss bug — `preferences` upsert is idempotent and the server's own `updated_at` trigger
  still enforces last-write-wins if the two requests race — but a genuinely avoidable duplicate
  network request the mutex was not actually positioned to prevent, because the click-triggered
  push was never inside it to begin with.

**If eliminating that redundant concurrent push matters, it needs one of:** folding the
click-triggered push into the same `syncInFlightRef`-guarded path (a real shape change from what
§2 sketched — `updatePreferences` would need to wait for or coordinate with `runSyncSequence`
rather than fire independently), or a small, dedicated in-flight guard scoped to the preferences
push specifically (checked by both the click handler and `runSyncSequence`'s own branch-check
before either issues a request) — narrower than reusing `syncInFlightRef` itself, since that flag's
current scope is "an attempts pull/flush/recompute sequence is running," not "a preferences push is
in flight."

### One adjacent, narrower risk worth naming rather than silently folding in

Not the scenario asked about, but directly adjacent and surfaced by the same trace: if a user makes
**two separate edits in quick succession** (not one edit racing one pull, but two fire-and-forget
pushes racing *each other*) — push A (older value) and push B (newer value) both in flight, and
A's response arrives *after* B's — a naive success handler that unconditionally sets `synced: true`
+ `preferencesUpdatedAt` from whichever response it's holding, without checking that response
actually corresponds to the *current* local state, could mark the record "synced" based on the
stale response A, even though B (the real, current local value) might still be in flight or might
since have failed. This is a distinct out-of-order-response risk, not the push-vs-pull race this
addendum was asked to trace, but it reinforces the same conclusion: an explicit in-flight guard
(or a check that a push's success response still matches the *current* local value before marking
`synced: true`) is warranted for full safety, not just for the specific window asked about here.
