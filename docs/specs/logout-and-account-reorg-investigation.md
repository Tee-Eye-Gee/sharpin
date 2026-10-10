# Investigation: Logout (Backlog #2) + Settings "Account" Reorg (Backlog #3)

Status: **Findings only — no spec, no build, no code changes.** For review before scope is locked.
Date: 2026-09-10

Scope note: these two backlog items are investigated together because Logout's UI home is inside
the new Account section (locked dependency per the prompt), but they are still logically separable
— the Account reorg is mostly a UI/layout question, while logout mechanics touch the sync system
built last session and are where the real risk lives.

---

## 1. Current State

### Session/auth state (client-side)

- `src/lib/supabaseClient.js` exports one shared `supabase` client. Session persistence is
  supabase-js's default — `localStorage`, no custom storage adapter (explicitly a locked decision
  per that file's comment).
- `App.jsx` holds session state in React: `sessionStatus` (`'checking' | 'valid' | 'none' |
  'disabled'`) and `session` (the actual Supabase session object), both plain `useState`. Nothing
  else in the app reads `supabase.auth.getSession()` directly except `storage.js`'s push/pull
  functions, which each independently call `supabase.auth.getSession()` right before acting.
- **There is currently no code path that ends a session.** No call to `supabase.auth.signOut()`
  anywhere in `src/` or `supabase/` (confirmed via search). Nothing sets `sessionStatus` back to
  `'none'` or clears `session` once set. The only way a session currently ends today is the token
  simply expiring/being invalidated server-side, or the user manually clearing browser storage.
- Boot flow: `App.jsx` calls `supabase.auth.getSession()` once on mount; a found session sets
  `sessionStatus: 'valid'`; none sets `'none'`, which shows `LaunchOverlay`. A fresh Login/Create
  Account within the same page load reaches `'valid'` via `LaunchOverlay`'s `onAuthenticated`
  callback instead.

### Settings screen structure

`src/components/SettingsPanel.jsx` is a single file, conditionally rendered by `App.jsx`
(`{settingsOpen && <SettingsPanel .../>}`), not a route — it's a floating panel:
- Fixed-position card (`top-16 right-4`, `w-72`), not a full-screen or full-width mobile layout.
  At ~375px viewport width this sits near the right edge with `max-w-[calc(100vw-2rem)]` as the
  only responsive concession — it does not restructure to a different layout on mobile.
- Backdrop (`fixed inset-0 bg-black/40`) closes the panel on click.
- Sections are plain `<section>` blocks separated by `<div className="my-4 border-t border-border" />`
  dividers, each with a small-caps `<h3>` label (`text-xs text-fg-muted uppercase tracking-widest
  font-medium mb-2`). Current sections, top to bottom: **Board Theme**, **Piece Movement**, and
  (conditionally, `loggedIn` only) **Profile**.
- `OptionButton` is the shared selectable-row primitive used by both Board Theme and Piece
  Movement (icon/swatch + label, accent border when selected). Profile is its own inline component
  (`ProfileSection`) with a text input + Save button, not built from `OptionButton`.
- `ProfileSection` deliberately has no sync-with-props effect — it reads `displayName` once at
  mount because `SettingsPanel` remounts fresh every time it's opened (App.jsx renders it
  conditionally, not persistently hidden). Any new Account-section component should follow the
  same assumption unless there's a reason not to.

### Existing logout-adjacent code

None. No dead code, no partial implementation, no stubs. The only place logout is described at all
is prose, in **§5 of `docs/specs/Sharpin_Spec_AccountSync.md`** ("Logout"), written back in the
original Aug 18 scoping pass — before the ongoing-sync system (push/retry-queue/pull/watermark)
existed. That's important for §2 below: the existing spec text predates the system it now has to
coexist with.

---

## 2. Logout Mechanics

### What a full logout needs to clear/reset

- **Supabase session**: `supabase.auth.signOut()` — clears the persisted `localStorage` session
  and the in-memory client session state.
- **App.jsx React state**: `session` → `null`, `sessionStatus` → `'none'`, `displayName` → `null`.
  `launchDismissed` also needs to reset to `false` so `LaunchOverlay` actually reappears (currently
  nothing resets it post-mount; it's only ever set `true`, never `false`).
- **In-memory app state**: puzzle-engine state (`usePuzzleEngine.js`) isn't identity-scoped today
  (see §5 risk below on mid-puzzle identity change) — spec §5's "reverts UI to standard opening
  board, standard starting rating" implies loading a fresh puzzle post-logout, not just leaving
  whatever was on screen.
- **Cached sync watermark (`lastPulledAt`)**: this is the sharpest open question. It's stored in
  the **same** `preferences` IndexedDB record as `appMode`/`boardTheme`/`inputMode` (see
  `DEFAULT_PREFERENCES` in `storage.js`) — there is no separate "this is per-account" store. See
  the architectural flag below; this is not a small detail.
- **Local IndexedDB guest/account state**: per spec §5 ("Underlying guest/local IndexedDB state...
  persists untouched — not wiped"), logout is specified to leave local data alone. This was a
  reasonable statement in August, before local IndexedDB became the landing spot for **synced
  account data** too (every push/pull writes through the exact same `attempts`/`profile`/
  `themeStats`/`preferences` stores used for guest play — there's no separate namespace). See the
  flag below.

### Interaction with the sync system — flush first, or safe to abandon?

Findings support **flush-first is required, but only under a specific race, and it's a small,
boundable one**, not the safe-to-ignore case:

- Push is already fire-and-forget per-attempt (`recordAttempt` → `pushAttemptIfPossible().catch(() =>
  {})`), and any failure just leaves `synced: false` for later retry — so an isolated failed push
  at logout time isn't itself dangerous; the row is durably queued locally either way.
- The actual risk is **which account** an unsynced row gets attributed to on the *next* sync
  pass, not whether the current logout's own in-flight push completes. See the architectural flag
  below — this is the same root cause as the local-storage-not-namespaced-per-account issue, not a
  separate problem.
- `runSyncSequence`'s `syncInFlightRef` mutex only prevents two sync sequences from running
  concurrently within one login session; it isn't consulted by, or aware of, a hypothetical logout
  action at all today.
- Recommendation to weigh (not decided here): logout should probably `await`
  `flushUnsyncedAttempts()` (best-effort, short timeout, non-blocking to the UI transition) before
  clearing session, purely to minimize the window in which locally-flagged-unsynced rows exist
  post-logout. This reduces but does not eliminate the deeper issue below, which is a storage
  architecture problem, not a timing problem.

### Logout vs. "switch to guest mode" — same or different end state?

Per the existing spec (§5), these already converge: "Logout... Returns to the 3-tier launch screen
(Guest / Create Account / Login)." Logout doesn't *directly* switch to guest mode — it returns to
the same launch screen a fresh boot-with-no-session shows, from which **Play as Guest** is just one
of the three choices, identical to any other visit to that screen. So there's no separate "switch
to guest" mechanic to design — logout already lands on the screen that offers it. Worth confirming
with Tiggs that this reuse is still the intended design now that the overlay's guest/account
migration logic exists (it didn't when §5 was written), since it does mean a fresh guest session
immediately after logout inherits whatever is sitting in local IndexedDB post-logout (see below).

### Risk of a logout mid-sync leaving IndexedDB inconsistent

Yes, and it compounds the architectural issue rather than being a separate concern:
- A `recordAttempt` write mid-logout could complete its local IndexedDB write but have its
  `pushAttemptIfPossible` call still in flight (or already failed) when `signOut()` clears the
  session. The row stays `synced: false` locally — not itself corrupt, just queued.
- The actual "inconsistent state" risk is what happens to that queued row **after** logout, once
  local storage is shared with whatever comes next (guest play, or a different account login) — see
  below.

### 🚩 Architectural flag (the load-bearing finding of this section)

**Local IndexedDB has no per-account/per-guest partitioning.** All four stores
(`profile`, `attempts`, `themeStats`, `preferences`) are keyed by a single fixed key (`'main'`
for profile/preferences; `attempts`/`themeStats` are simply global to the one IndexedDB database).
This was fine when the only actor was "this device's guest," and it was fine through Stage 3
because logout didn't exist yet to ever hand the same local storage to a *second* identity. Once
logout exists, spec §5's "local IndexedDB persists untouched" collides with the sync system built
after that spec text was written:

1. **Post-logout, local storage still contains the just-logged-out account's full synced history**
   (attempts, rating, streaks, theme stats, board theme) — not just pre-login guest data. Nothing
   distinguishes "this row is guest data" from "this row is Account A's synced data" once they're
   both sitting in the same `attempts` store.
2. If the user (or anyone else on a shared device) then plays as **Guest** post-logout, new attempts
   append into the same store, on top of Account A's data, with `synced: true` rows from Account A
   mixed with new `synced: false` guest rows.
3. If that guest session later runs **Create Account** or **Login**, `migrateGuestDataToAccount`'s
   pre-check only asks "does the *new* account already have remote rows?" — it does not know that
   the "local guest history" it's about to migrate actually contains a *previous account's* data.
   A Merge in this state would push Account A's puzzle history into Account B's `puzzle_attempts`
   table under Account B's `profile_id` — a real cross-account data leak, not just a UI glitch.
4. Symmetrically, `lastPulledAt` (in `preferences`) surviving a logout means a subsequent different
   account's first pull uses a stale, wrong-account watermark, potentially skipping rows it should
   have pulled (watermark too advanced for the new account) — low-severity compared to #3, but
   still wrong.

This needs an explicit decision before logout is built, not just an implementation detail:
- **Option A** — Logout also resets local IndexedDB (something like `resetAllLocalData()`, which
  already exists and is used by the Discard migration path) before returning to the launch screen.
  Matches the sync system's actual current shape; contradicts spec §5's literal text ("persists
  untouched — not wiped"), so §5 needs a deliberate rewrite, not a quiet override.
- **Option B** — Local storage becomes genuinely per-identity (e.g. namespace stores/keys by
  profile id, with a distinct "guest" namespace), so guest data and every account's synced data can
  coexist without collision, and logout literally does nothing to local data because there's no
  cross-contamination possible. Bigger lift; changes `storage.js`'s core key scheme, not just
  logout.
- **Option C** — Logout wipes only the sync-specific fields (`synced`/`remoteId` on attempts,
  `lastPulledAt`) but keeps solve history/ratings/theme stats as anonymous local numbers, accepting
  that a subsequent guest inherits an ex-account's stats as if they were their own guest progress.
  Cheapest, but keeps the cross-account Merge leak in #3 alive in a milder form (the numbers leak
  even if the *identity* doesn't).

This is the same category of thing as the sequence-reset flag from last session — architecturally
non-trivial, decided before implementation starts, not discovered mid-build.

---

## 3. Settings "Account" Reorg

### Proposed structure (for review, not decided)

A concrete shape, following the existing `SettingsPanel.jsx` section pattern (small-caps `<h3>`
label + divider, same as Board Theme/Piece Movement):

```
Settings
├─ Board Theme        (unchanged, stays where it is — see theme question below)
├─ Piece Movement      (unchanged)
├─ Account              [only rendered when loggedIn — same gating as today's Profile section]
│    ├─ Display name    [already shipped — today's ProfileSection, moved under this header]
│    ├─ (future) Sequence reset
│    ├─ (future) Password/credential reset — n/a today (no password exists; this may map to
│    │   "change move sequence" rather than a separate concept)
│    └─ Logout          [new]
└─ (logged out only) — no Account section at all; Login/Create Account live on LaunchOverlay,
     not here, matching the existing `loggedIn` gate
```

Notes:
- This is additive to the existing conditional render (`{loggedIn && (...)}`) — just renamed from
  "Profile" to "Account" and given a second control (Logout) beneath display name, rather than a
  structural rework of `SettingsPanel.jsx`.
- Logout should probably be visually distinct (e.g. a plain destructive-styled button, not an
  `OptionButton` selectable row, since it's an action, not a persisted choice) — matches how Merge/
  Discard in `LaunchOverlay.jsx` are styled as action buttons, not options.
- Whether Logout needs a confirmation step (a puzzle in progress, an unflushed queue) is worth a
  decision at spec time — not addressed by this investigation beyond flagging it.

### Where does theme selection live — does anything need to move?

Board Theme (and Piece Movement/input mode) are app-wide **local** preferences unrelated to
identity — they apply to guests too, and today they're stored the same way regardless of login
state (`getPreferences()`/`savePreferences()`, no account gating). There's no reason surfaced by
this investigation for them to move into Account — they're not identity-scoped concepts, and
Account, per the reorg's own framing, is specifically for identity/session actions. Recommend they
stay exactly where they are, structurally separate from Account.

One real wrinkle, surfaced while checking this: **board theme is a `preferences` column server-side
(`board_theme`), written to Supabase only once — during guest-to-account migration's upsert
(`LaunchOverlay.jsx`'s `migrateGuestDataToAccount`) — and never pulled back down.** There is no code
path today that reads `preferences` from Supabase on login/pull the way `puzzle_attempts` is
pulled. This directly affects §4 below (round-trip verification) and is a pre-existing gap, not
something introduced by this investigation's scope — flagging it here because Account reorg framing
("does board theme belong near Account") is what surfaced it.

### Existing component patterns to follow

- Section header style: `text-xs text-fg-muted uppercase tracking-widest font-medium mb-2`.
- Section divider: `<div className="my-4 border-t border-border" />` between every section, not
  just some.
- Selectable-option rows use the shared `OptionButton` primitive; a destructive action like Logout
  should NOT reuse it (it's built for is-this-selected semantics, not a one-shot action).
- Panel itself is fixed-position, `w-72`, anchored `top-16 right-4`, capped at
  `max-w-[calc(100vw-2rem)]` for narrow viewports — confirmed this is the only mobile
  accommodation; there's no alternate full-screen layout under a breakpoint. At 375px width this
  leaves roughly a 16px gutter on each side inside the card. Adding a third gated section (Account)
  makes the panel taller, not wider — no layout risk there, just a longer scroll inside a
  already-fixed-height-unconstrained card (no internal scroll region exists today; the panel simply
  grows with content). Worth confirming that's still acceptable once Account adds 2 (Display name +
  Logout) more rows of vertical space on top of Board Theme's 4 options + Piece Movement's 2.

---

## 4. The Round-Trip Verification Blocker

Once logout exists, a full **login → change settings → logout → relogin** verification pass needs
to check, specifically:

**Profile display name:**
- This one is straightforward: `display_name` lives server-side in `profiles`
  (`update-profile` Edge Function writes it; `App.jsx`'s effect fetches it fresh on every
  `sessionStatus → 'valid'` transition keyed off `session.user.id`). A relogin re-fetches it from
  the server regardless of what's in local IndexedDB — there's no local cache of `displayName` at
  all (`App.jsx` state resets to `null` on mount every time). **This should already round-trip
  correctly today**, contingent only on logout correctly resetting `displayName` to `null` in the
  interim (§2) so a relogin's fetch isn't masked by stale state — low risk, but worth asserting
  explicitly in the verification rather than assumed.

**Board theme inheritance:**
- This is the one to actually worry about, per the gap found in §3: **there is no pull path for
  `preferences` from Supabase.** Board theme is persisted only in local IndexedDB
  (`getPreferences()`/`savePreferences()`), applied via `applyTheme()` on mount from whatever's
  locally stored. The only time `preferences` is ever written server-side is the one-shot
  migration upsert at account creation.
- Concretely: change board theme while logged in on Device A → theme is saved to *local*
  IndexedDB only (never re-pushed to Supabase after the initial migration-time upsert, since
  `selectBoardTheme` in `App.jsx` only calls `savePreferences`, never anything Supabase-facing).
  Logout on Device A (if Option A/local-wipe from §2 is chosen) would **delete the very board-theme
  change** the verification is trying to confirm persisted, because it was never pushed anywhere
  durable outside that same local store. Relogin (same device or a different one) would fall back
  to whatever `preferences` last landed server-side — which, if the wipe-on-logout option is taken,
  is stale from account-creation time, not the just-made change.
- **This means the round-trip test as posed cannot pass today, independent of how logout gets
  built**, unless one of the following is also decided/built first: (a) board theme (and the rest
  of `preferences`) gets a real ongoing push (mirroring how `puzzle_attempts` pushes after every
  attempt) and a real pull-on-login (mirroring `pullRemoteAttempts`), or (b) the verification's bar
  for "board theme inheritance" is redefined to mean something achievable today (e.g. "survives a
  logout that doesn't wipe local data," which only works under §2's Option C, not A or B).
- Recommend surfacing this to Tiggs explicitly before the Account reorg / logout spec is locked —
  it's not something a smaller logout-side decision can route around; it's a preexisting sync-scope
  gap that this verification target happens to expose.

---

## 5. Open Questions / Risks (summary)

Ranked by how architecturally non-trivial they are, most first:

1. **No per-account/per-guest local storage partitioning** (§2). Logout, as currently specced in
   §5 of the AccountSync spec ("local IndexedDB persists untouched"), was written before the sync
   system existed and now conflicts with it — building logout without resolving this risks a
   cross-account data leak via the existing guest-to-account Merge path. Needs an explicit
   Option A/B/C decision (§2) before any logout code is written.
2. **`preferences` (board theme, app mode, input mode) has no ongoing sync** — push exists only as
   a one-time migration-time upsert; there is no pull path at all (§3, §4). This blocks the
   board-theme half of the round-trip verification as posed, and is orthogonal to logout itself —
   it's a gap in the sync system shipped last session, surfaced by this investigation rather than
   caused by it.
3. **`launchDismissed` and other App.jsx state have no reset path** — logout needs to reset more
   local React state than just `session`/`sessionStatus` (§2); easy to miss one and end up with a
   UI that's logged out but still behaving as if mid-session in some corner.
4. **No confirmation/flush step decided for logout while a sync is in flight** — not dangerous today
   (fire-and-forget push already tolerates failure) but the *next* identity to touch local storage
   inherits whatever queue state logout leaves behind (tied to risk #1).
5. Minor: Logout button styling/placement and whether it needs a confirm dialog is a small,
   normal product decision, not flagged as a risk — noted in §3 only for completeness.

### Production Supabase / live-write scope check

Per standing rule, flagging explicitly: **none of the investigation above required, and this
document proposes no, live writes against the production Supabase project.** Building logout itself
will eventually need `supabase.auth.signOut()` calls verified against a real session (likely the
existing `TEST_FIXTURE_KEEP` test account per CLAUDE.md's Test Fixtures section) — that live
verification work is out of scope for this investigation-only pass and should get its own
before-not-after confirmation when build/verification actually starts, per the standing live-write
rule. Similarly, if Option A or B from §2 is chosen, resolving them may involve a `preferences`
pull path that reads from the production project during verification — same rule applies, flagged
now so it isn't a surprise later.
