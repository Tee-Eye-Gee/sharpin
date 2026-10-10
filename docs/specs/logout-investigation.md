# Investigation: Logout (Backlog #2) + Settings "Account" Reorg (Backlog #3) — Revisited

Status: **Findings only — no code changes, no commits, no writes to Supabase (local or
production).** For review before scope is locked.
Date: 2026-09-12

Prerequisite reading (per the prompt, both reviewed before writing anything below): `CLAUDE.md`
(storage-partitioning section, theme/preferences-sync section, and the `usePuzzleEngine` blocking
precondition — **not touched by this investigation, confirmed out of scope per the prompt**), and
`docs/specs/storage-partitioning-investigation.md` in full (original findings + all four addenda).
This investigation supersedes `docs/specs/logout-and-account-reorg-investigation.md` (2026-09-10)
on every point where the two intervening builds (storage partitioning, theme/preferences sync)
changed the answer — flagged explicitly below wherever that happens, rather than silently
restating the older document's now-stale conclusions.

**Headline change since the 2026-09-10 document:** that investigation's own §5 ranked "no
per-account/per-guest local storage partitioning" as risk #1 and "`preferences` has no ongoing
sync" as risk #2 — both blocking a real logout build. **Both are now shipped, live-verified, and
closed** (storage partitioning: 4/4 commits done; theme/preferences sync: closed, live-verified
against production 2026-09-12, per CLAUDE.md). This investigation is not re-litigating those
decisions; it is checking what changed as a result, and — per the prompt's explicit critical
ask — whether either shipped design's own internal assumptions still hold now that logout is
about to become real. **They mostly do. One does not, and it's more serious than the one the
prompt named.**

---

## 1. Current State

### No logout code exists — reconfirmed, not assumed

```
grep -rni "signOut|sign_out|logout|logOut" src/ supabase/
```
returns zero matches in actual code. The only hits repo-wide are in `CLAUDE.md` and the two
investigation docs (prose, not code). Reconfirmed after two more builds (storage partitioning,
theme/preferences sync) landed on top of the 2026-09-10 finding — neither touched auth/session
teardown; both are additive to local-storage keying and to the `preferences` push/pull path
respectively. **Still true: there is no code path anywhere in this repo that ends a session.**

### Session/auth state (client-side) — current shape

Traced directly against `src/App.jsx` (983-line `storage.js` and 425-line `LaunchOverlay.jsx` also
read in full):

- `src/lib/supabaseClient.js` exports one shared `supabase` client, default `localStorage`
  session persistence (locked decision, unchanged).
- `App.jsx` holds `sessionStatus` (`'checking' | 'valid' | 'none' | 'disabled'`, `'disabled'` is
  new since the last investigation — the feature-flag-off terminal state), `session`,
  `launchDismissed`, `displayName`, plus `appMode`/`boardTheme`/`inputMode` (local preference
  state, now backed by the full push/pull system).
- **New since 2026-09-10: boot is one ordered async sequence, not three independent effects**
  (`App.jsx:107-151`) — resolve session → `adoptLegacyDataIfSafe(identity)` → load preferences.
  This ordering is load-bearing for storage partitioning (§2 below) and is itself unaffected by
  logout not existing, because — as traced in detail below — logout cannot re-trigger this
  sequence within a page load at all.
- `runSyncSequence` (`App.jsx:184-206`) now also calls `syncPreferences()` (theme/preferences
  sync), riding the same `syncInFlightRef` mutex and the same login/foreground triggers as the
  attempts pull/flush/recompute chain.
- Still true, unchanged: nothing sets `sessionStatus` back to `'none'` once `'valid'`; the only
  way a session currently ends is real token expiry/revocation or manual storage clearing.

### Settings screen structure — current shape

`src/components/SettingsPanel.jsx`, still a conditionally-rendered floating panel (not a route),
structurally unchanged from the 2026-09-10 findings:

- Fixed-position card, `top-16 right-4`, `w-72`, `max-w-[calc(100vw-2rem)]` — the only mobile
  accommodation, no alternate layout under a breakpoint, no internal scroll region (panel just
  grows with content).
- Sections: **Board Theme**, **Piece Movement**, and (`loggedIn` only) **Profile** — still named
  "Profile," not "Account"; the reorg has not happened yet.
- `ProfileSection` (`SettingsPanel.jsx:14-79`) is the shipped display-name editor
  (`docs/specs/Sharpin_Spec_ProfileDisplayName.md`) — reads `displayName` once at mount, no
  sync-with-props effect, relies on `SettingsPanel` remounting fresh every open. Any new
  Account-section component should follow the same assumption.
- `OptionButton` (`SettingsPanel.jsx:81-91`) is the shared selectable-row primitive for Board
  Theme/Piece Movement. Not reused by `ProfileSection`, and — per the 2026-09-10 recommendation,
  still valid — should not be reused for Logout either (action, not a persisted choice).
- `Header.jsx` confirmed: gear icon opens Settings, sun icon toggles app mode. No account/session
  affordance anywhere in the header — Logout's only sensible home is inside Settings, exactly as
  scoped.

---

## 2. Logout Mechanics

### What a full logout needs to clear/reset — current, post-partitioning shape

- **Supabase session**: `supabase.auth.signOut()` — unchanged from the prior investigation.
- **App.jsx React state**: `session → null`, `sessionStatus → 'none'`, `displayName → null`,
  `launchDismissed → false` (still needs an explicit reset path — none exists today; still true).
- **Local preference display state — a genuinely new requirement, not present in the 2026-09-10
  findings because `preferences` had no ongoing sync yet at that point.** `App.jsx`'s
  `appMode`/`boardTheme`/`inputMode` `useState`s are only ever populated by the boot effect
  (`App.jsx:107-151`), which runs once per mount. **Logout does not remount the app** (a plain
  state-reset action, not a reload), so nothing will automatically re-run that effect for the
  now-active identity (guest, most likely) once logout completes. If logout only clears session
  state and stops there, the UI will keep rendering the just-logged-out account's board
  theme/app mode/input mode colors and settings indefinitely, even though the underlying identity
  has changed — a real, user-visible bug, not cosmetic (it visually misrepresents whose
  preferences are active). **Logout's implementation needs to explicitly re-run the
  identity-scoped preferences load + `applyTheme()` call** (the same three lines `App.jsx`'s boot
  effect already does at lines 131-146), for the newly-resolved (guest) identity — it cannot rely
  on a remount to do this for free.
- **Cached sync watermarks (`lastPulledAt`, `preferencesUpdatedAt`)**: **this concern from the
  2026-09-10 document is now closed, not open.** Both watermarks live inside the `preferences`
  IndexedDB record, which storage partitioning made per-identity (keyed by `identity`, not a bare
  `'main'` key). A different account's own `preferences` record has its own independent
  watermarks, defaulting to `null` on first read. There is no shared/global watermark left to leak
  across accounts. Confirmed by re-reading `DEFAULT_PREFERENCES`/`getPreferencesFor` — nothing
  about this requires new logout-side logic at all.
- **Local IndexedDB namespaced data (`attempts`/`profile`/`themeStats`/`preferences`, keyed or
  tagged to the just-logged-out account)**: see the architectural section below — this is now a
  **privacy/hygiene decision, not a correctness-critical one**, a meaningfully different framing
  than the 2026-09-10 document's Option A/B/C (which was written to solve a *correctness* leak that
  storage partitioning has since closed by construction).
- **In-memory puzzle-engine state** (`usePuzzleEngine.js`): explicitly not traced or touched by
  this investigation, per the prompt. Flagged only at the level the prompt allows: whatever
  gating Logout's own UI needs (§5) is the same *kind* of gating `LaunchOverlay`'s
  `actionsDisabled`/`puzzleAttemptInFlight` already implements for Login/Create Account
  (`App.jsx:286-287`) — this section does not propose touching `usePuzzleEngine.js` itself.

### 🚩 Interaction with the sync systems — NOT "flush vs. abandon." A newly-reachable
attribution/corruption bug, traced concretely.

The 2026-09-10 document framed this as "flush-first is required, but only under a small, boundable
race." **That framing undersold the actual risk, because it was written when the only same-page-
load identity transition possible was `none → valid` (guest → account, via Create Account/Login).
Logout adds two new transition directions — `valid → none` and, critically, `valid(A) → valid(B)`
— and the existing fire-and-forget push design was never built to survive either.**

**The root cause, traced directly against the shipped code, is the same in both sync systems:**
each push function re-resolves "whose data is this" from the *live, current* session at the moment
its own network call actually executes, not from the identity that was active when the write was
originally queued.

- `pushAttemptIfPossible` (`storage.js:601-623`): `const { data: { session } } =
  await supabase.auth.getSession()` happens *inside* this function, and `profile_id:
  session.user.id` is read from that fresh call — **not** from `attempt.ownerId`, which was
  already resolved and tagged onto the local record back in `recordAttempt`
  (`storage.js:756-800`). `recordAttempt` calls `pushAttemptIfPossible({...}).catch(() => {})`
  fire-and-forget, immediately after its own local IndexedDB writes complete — there is a real,
  non-instantaneous window here: the local writes themselves, then this function's own
  `getSession()` call, then the actual `puzzle_attempts` network insert (which can take anywhere
  from tens of ms to multiple seconds on a slow connection).
- `pushPreferencesIfPossible` (`storage.js:233-254`): identical shape — `session.user.id`
  read fresh, used as the upsert's `profile_id`, independent of the `identity` parameter the
  caller (`updatePreferences`) already resolved and threaded through for the *local*
  `pendingToken` check that happens later in the same function.

**Confirmed this is not an RLS backstop that happens to save it:** both `puzzle_attempts` and
`preferences` are `for all ... using (auth.uid() = profile_id) with check (auth.uid() =
profile_id)` (`supabase/migrations/20260819140001_rls_policies.sql:33-38`, and the identical shape
for `preferences`). This does **not** help here, because the client-side code being traced always
sets `profile_id` to `session.user.id` — the *same* session it's about to authenticate the call
with. The write is tautologically self-consistent from RLS's point of view no matter *which*
identity happens to be live at execution time. RLS enforces "you can only write rows you claim as
your own"; it has no way to know the data underneath was actually earned by a different identity.

**Concrete scenario, traced step by step — Account A is logged in, solves a puzzle, then the user
logs out and logs into Account B within the same page load, fast enough to land inside the push's
own async window:**

1. `recordAttempt` resolves `identity = A`, locally appends the attempt tagged `ownerId: 'A'`,
   `synced: false`. Fire-and-forget `pushAttemptIfPossible(...)` is dispatched.
2. Before that call's own `getSession()` resolves (or before its subsequent network insert
   completes — the larger, more realistic window), the user clicks Logout (session cleared) and
   then Login/Create Account for B (a new session for B is now live).
3. `pushAttemptIfPossible`'s `getSession()` call — still in flight from step 1 — now resolves with
   **B's** session (it reads whatever is live *right now*, with no memory of what was live when it
   was called). It inserts A's real attempt data (puzzle id, `rating_delta`, timestamps — all
   correct in content, wrong in ownership) into `puzzle_attempts` under **B's** `profile_id`. RLS
   passes, because the insert is self-consistent (`profile_id` came from the same session
   authenticating it).
4. On success, `markAttemptSynced(attempt.id, attempt.remoteId)` fires — this updates the **local**
   record by its local autoincrement `id`, unconditionally, setting `synced: true` on the row still
   tagged `ownerId: 'A'` locally. **A's own local copy now believes it's synced/confirmed — it will
   never be retried by any future `flushUnsyncedAttempts()` call, for A or anyone else — but the
   row that actually exists server-side under A's real account was never written.** A permanently
   loses this attempt from their own account's server-side history, silently, with no error
   surfaced anywhere. B's `puzzle_attempts` (and, downstream, B's `recompute_stats()`-derived
   rating/streak/theme accuracy) now includes an attempt B never made.

**The preferences case is the same shape but worse in kind, because `preferences` is a single-row
upsert, not an append-only insert:** if A's in-flight preference push resolves after B's session is
live, it **overwrites B's real `board_theme`/`app_mode`/`input_mode` row with A's stale values**,
immediately, with no dedup or append semantics to fall back on — a genuine live corruption of
Account B's own settings the instant B logs in, not just a missing-row omission. It compounds
further: `pushPreferencesIfPossible`'s later `getPreferencesFor(identity)` call uses the `identity`
closed over from *initiation* time (A) for its **local** `pendingToken` check — so A's own local
record gets marked `synced: true` (since nothing else touched A's local `pendingToken` in the
interim), even though what actually landed server-side was written under B's `profile_id`. If A
later logs back in, `syncPreferences()` sees local `synced: true` and skips re-pushing; whether it
also skips *pulling* A's real value back down depends on how A's falsely-stamped local
`preferencesUpdatedAt` (taken from the stray response, which returned *B's* row's `updated_at`)
compares to A's real server-side row's `updated_at` — a further, compounding possible failure on
top of the initial corruption of B's row.

**Is this new, or already-latent?** Partially latent, meaningfully worsened by logout:

- The **`none → valid` direction** (a guest's own fire-and-forget push resolving *after* the same
  page load completes Create Account) is **already reachable today, without logout** — confirmed
  by the same trace. It's largely self-healing in the *attempts* case (the same `remoteId` is
  reused by `migrateGuestDataToAccount`'s own Merge insert, so a `23505` conflict absorbs the
  duplicate attempt correctly under the new account either way) — but it is **not** self-healing if
  the user chooses **Discard**: a guest attempt whose stray push already landed under the new
  account before Discard resets local guest data would leave that one row sitting in the new
  account's `puzzle_attempts` even though Discard's entire promise is "start fresh, guest history
  dropped." This is a real, narrow, pre-existing gap, surfaced by this trace, not previously
  documented.
- The **`valid(A) → valid(B)` direction is genuinely new** — it requires logout to exist at all
  (there is no way to reach a second `valid` session within one page load otherwise) — and has **no
  analogous self-healing path**, because there's no Merge/Discard-style reconciliation UI when
  switching between two *already-existing* accounts. This is the direction that needs a real
  design decision as part of logout's scope, not an inherited assumption from the existing
  guest-to-account flow.

**Recommended direction (not a decision, not implemented here):** pin the identity at
write-initiation time (both `recordAttempt` and `updatePreferences` already resolve `identity`
once, up front — `pushAttemptIfPossible`/`pushPreferencesIfPossible` would need that identity
threaded through as a parameter, exactly the same shape as `pendingToken`'s own precedent) and have
each push function **compare it against the session actually live at execution time**, aborting
(no-op, leave `synced: false`) on a mismatch rather than proceeding — the row then correctly waits
for a future boot/relogin where its *own* identity is live again, which `flushUnsyncedAttempts`'s
existing `ownerId`-filtered scoping already handles correctly. This is structurally the same shape
as the already-shipped `pendingToken` guard, just checking *identity* agreement instead of
*edit* agreement, and would need to land in **both** push functions, not just one. Building this
(or an equivalent) is what would let logout treat in-flight pushes as **safe to abandon** rather
than needing to await them — the "flush first" framing from 2026-09-10 turns out to be the wrong
fix entirely: flushing *earlier* doesn't close a race that lives inside the push call itself, and
an await-based alternative would require new infrastructure (a promise registry for currently
fire-and-forget calls) that doesn't exist anywhere in this codebase today. **This is scope for
whoever builds logout to decide on explicitly — flagged here as a required design decision, not a
recommendation to build silently.**

### Logout vs. "switch to guest mode" — same or different end state?

**Same end state, and — unlike the 2026-09-10 document, which could only flag this as an open
architectural risk — this can now be answered with confidence, thanks to storage partitioning
already shipping:** Logout returns to the same `sessionStatus === 'none'` launch screen a fresh
boot-with-no-session shows (per the existing spec §5 framing, unchanged). "Play as Guest" from
that screen resumes whatever is currently sitting in the **`GUEST_IDENTITY` namespace specifically**
— which, thanks to Option A's tagging, can *never* be confused with or contain a different
account's data by construction (every read filters by exact `ownerId`/key match). Concretely, by
the time any account first logs in, the guest bucket is already either merged away (Merge
reassigns `ownerId`) or wiped (Discard calls `resetAllLocalData({ identity: GUEST_IDENTITY })`) —
so a genuine guest session immediately after a logout starts from whatever guest data has
accumulated since the *last* such reconciliation, never from the just-logged-out account's data.
**No separate "switch to guest" mechanic needs to be designed — reusing the existing launch screen
is correct, and is now provably safe rather than merely convenient.**

### Risk of a logout mid-sync leaving IndexedDB inconsistent

Reframed by the finding above: the risk is not "IndexedDB ends up inconsistent" in the sense of
malformed/partial records — every write in `storage.js` is already transactional per-store. The
real risk is the **attribution** race just traced (§ above), which is a correctness problem, not a
consistency-of-shape problem. Once that's addressed (via the identity-pinning guard or an
equivalent), there is no remaining IndexedDB-shape risk from a logout-mid-sync scenario that this
investigation can find.

---

## 3. Settings "Account" Reorg

### Proposed structure — unchanged from 2026-09-10, still recommended

```
Settings
├─ Board Theme        (unchanged, stays where it is)
├─ Piece Movement      (unchanged)
├─ Account              [only rendered when loggedIn — same gating as today's Profile section]
│    ├─ Display name    [already shipped — today's ProfileSection, moved under this header]
│    ├─ (future) Sequence reset   — Backlog #4, do not scope its build here
│    ├─ (future) Password/credential reset — n/a today (no password exists; likely maps to
│    │   "change move sequence," same Backlog #4 item, not a separate concept) — do not scope
│    └─ Logout          [new]
└─ (logged out only) — no Account section at all; Login/Create Account stay on LaunchOverlay
```

Nothing about the intervening builds changes this shape. Still recommended: Logout as a plain
destructive-styled action button, not an `OptionButton` (is-this-selected semantics don't fit an
action). Still worth a spec-time decision on whether Logout needs a confirm step — not resolved
here, same as before.

### Does theme selection need to move? — Confirmed: no, and the reason has gotten stronger

The 2026-09-10 document recommended Board Theme/Piece Movement stay outside Account because
they're identity-independent, local-first preferences — but flagged a real wrinkle: *"board theme
is written to Supabase only once, at migration time, and never pulled back down."* **That wrinkle
is now fully resolved** — `preferences` has real ongoing push (every change) and pull (login/
foreground, mutually-exclusive branch), live-verified cross-device. Board theme is now exactly as
identity-scoped-but-not-identity-exclusive as it was meant to be from the start: it applies to
guests too, is stored the same way regardless of login state, and now *also* correctly survives
across devices for logged-in accounts. This strengthens, rather than changes, the original
recommendation: theme selection stays structurally separate from Account.

### Existing component patterns to follow — unchanged

- Section header: `text-xs text-fg-muted uppercase tracking-widest font-medium mb-2`.
- Section divider: `<div className="my-4 border-t border-border" />` between every section.
- `OptionButton` for selectable rows; Logout should not reuse it (per above).
- Panel: fixed-position, `w-72`, `top-16 right-4`, `max-w-[calc(100vw-2rem)]`, no internal scroll
  region, grows with content. At ~375px width, adding Account's 2 rows (display name + Logout) on
  top of Board Theme's 4 + Piece Movement's 2 makes the panel taller, not wider — still no layout
  risk, same conclusion as before, worth reconfirming visually once built since nothing has
  actually changed the panel's layout code since the last investigation looked at this.

---

## 4. The Round-Trip Verification Blocker — Reassessed

**This is the section where the intervening work changes the answer most substantially.** The
2026-09-10 document concluded the login → change settings → logout → relogin verification
**"cannot pass today, independent of how logout gets built,"** because `preferences` had no pull
path at all. That blocker is gone. What's left to check is narrower and mechanical, not a missing
system.

**Profile display name — unchanged conclusion, still correct:** `display_name` lives server-side
in `profiles`, fetched fresh on every `sessionStatus → 'valid'` transition keyed off
`session.user.id` (`App.jsx:159-172`), with no local cache at all. This effect depends on
`[sessionStatus, session]`, so it will correctly re-fire on a same-page-load relogin (after a
hypothetical logout resets both), no reload required. **What should persist:** the value itself,
server-side, unaffected by logout. **What should reset:** `displayName` React state to `null` at
logout time, so a fast relogin to a *different* account doesn't flash the previous account's stale
name for one render before the fetch resolves — a minor UI-correctness nit, not a data risk, worth
naming explicitly in the build spec anyway.

**Board theme (and app mode / input mode) inheritance — now mechanically capable of passing, with
two concrete new preconditions logout's own build must satisfy (both already named above, restated
here for this checklist):**

1. **The identity-pinning guard from §2** must exist (or an equivalent), or the round-trip test
   itself becomes the exact scenario that can corrupt a *different* account's preferences if timed
   unluckily — this is not hypothetical caution, it's the literal mechanism the test would be
   exercising.
2. **Logout must explicitly reload preferences for the newly-resolved identity** (the new
   requirement from §2 — `App.jsx`'s boot effect won't rerun on its own).

**What should persist across the round trip:** the account's real `board_theme`/`app_mode`/
`input_mode`, because they're now pushed on every change and pulled on every login — whether or
not logout wipes local IndexedDB is irrelevant to correctness here (§5's privacy/hygiene framing),
because the server copy is authoritative and pull-on-login will repopulate a wiped local record
correctly (confirmed by the same mechanism already live-verified 2026-09-12 for the cross-device
case — a same-device logout→relogin pull is mechanically identical to that already-proven
cross-device pull, just triggered by the login-trigger effect instead of a different device's first
boot).

**What should reset:** nothing about the *stored* preference value — only the transient local React
display state between logout and the next identity's preferences actually loading (covered by
precondition 2 above).

**Net: the literal logout→relogin round trip is still blocked on logout not existing yet — but it
is no longer blocked on any missing sync mechanism.** Once logout is built with the two
preconditions above satisfied, this verification should be straightforwardly achievable, unlike the
2026-09-10 assessment.

---

## 5. Open Questions / Risks

Ranked by how architecturally non-trivial they are, most first:

1. **🚩 The fire-and-forget push identity-attribution race (§2) — the most serious finding in this
   investigation, not previously documented anywhere.** Both `pushAttemptIfPossible` and
   `pushPreferencesIfPossible` resolve "whose data is this" from the live session at
   execution-time, not the identity active at initiation-time. Once logout allows a same-page-load
   `valid(A) → valid(B)` transition, a fire-and-forget push still in flight from A's session can
   land under B's account — silently losing A's attempt from A's own history while polluting B's,
   or (worse, single-row upsert with no dedup) directly overwriting B's real preferences with A's
   stale values the instant B logs in. **Must be designed and closed as part of logout's own scope
   — recommended direction is an identity-pinning guard in both push functions (§2), which also
   changes the answer to "does logout need to flush in-flight pushes" from yes to no.** A narrower,
   already-latent version of this (guest → account direction, breaks Discard's guarantee in a rare
   race) exists today independent of logout and is also worth fixing at the same time, since the
   fix is the same code change either way.

2. **Local IndexedDB post-logout retention — now a privacy/hygiene decision, not a correctness
   one.** Unlike the 2026-09-10 framing (Option A/B/C to close a cross-account *leak*), storage
   partitioning already makes cross-identity reads structurally impossible regardless of whether a
   logged-out account's local data is retained or wiped. The remaining question is narrower:
   should a shared/public device's IndexedDB continue to hold a previous account's cached
   rating/history/theme data indefinitely after logout (inspectable via devtools by the next person
   to use that device)? Recommend an explicit decision at spec time either way — not blocking, not
   architecturally risky, just worth naming rather than defaulting silently.

3. **Logout button needs the same puzzle-in-progress gating Login/Create Account already have.**
   `LaunchOverlay`'s `actionsDisabled`/`puzzleAttemptInFlight` pattern (`App.jsx:286-287`) exists
   specifically to prevent an in-flight, uncommitted puzzle attempt from racing an identity
   transition. A Logout control needs the equivalent gating, or a mid-attempt logout followed by
   a commit becomes another way to reach the same class of attribution ambiguity as risk #1 (though
   at the UI-interaction level rather than the network-race level) — belt-and-suspenders alongside
   the guard in #1, not a substitute for it.

4. **`launchDismissed` and other transient `App.jsx` state need an explicit, enumerated reset list**
   at logout — unchanged finding from 2026-09-10, still true, still easy to under-scope (miss one
   piece of state and end up with a UI that's logged out but behaving as if mid-session in some
   corner).

5. **✅ CRITICAL FORWARD-DEPENDENCY, as the prompt required — `adoptLegacyDataIfSafe` and its
   deferred-marker design, traced concretely against logout's actual future existence: the existing
   design remains correct as-is. No change needed.** Full trace:
   - `adoptLegacyDataIfSafe` is invoked from exactly one call site — `App.jsx`'s boot effect
     (`App.jsx:107-151`), which runs once per mount via an empty-dependency `useEffect`. Logout, as
     scoped, is a React state transition, not a remount/reload. **This means logout cannot
     re-trigger the adoption routine within a page load at all**, regardless of how many
     guest/account transitions happen afterward in that same session — the specific scenario named
     in the prompt ("logout, then a guest attempt, then a different account logging in later on the
     same device") only reaches a *second* adoption check if "later" means a genuinely later page
     load (a fresh boot).
   - On any such later boot, the routine's own presence-based idempotency (no separate "done" flag
     — see the storage-partitioning investigation's third addendum) means it only ever does
     anything if genuine **pre-Commit-1, un-namespaced legacy data** (a bare `'main'` key record,
     or an attempts row with no `ownerId` at all) still exists on that device. **No code path
     anywhere in the shipped, partitioned codebase writes data in that legacy shape anymore** —
     every write since Option A shipped goes through `resolveIdentity()` or an explicit identity
     parameter and is always tagged. Logout (built correctly, i.e. without reintroducing a bare-key
     write path) cannot create new legacy-shaped data either. **The population of devices that
     could ever trigger a real adoption action is fixed and only shrinks over time — it cannot grow,
     with or without logout.**
   - The one genuine residual case is a device that was *deferred* (real pre-existing legacy data,
     provably-not-a-guest via the `synced === true` heuristic, session unconfirmed) and never
     reaches a confirmed boot under its *original* account. The storage-partitioning investigation's
     own third addendum already documented, explicitly, that a later confirmed boot adopts the
     stranded data "into whichever identity is now confirmed" — meaning a *different* account
     logging in next (already possible today via natural session death + Login to a different
     account, with no logout involved) can inherit it. **Logout does not worsen this** — it adds no
     new way to reach this state, since it cannot retrigger the routine mid-session, and any device
     that has already completed one confirmed adoption has zero legacy data left for any future
     boot, logout-enabled or not, to misattribute. This residual was already named and accepted in
     the prior investigation; it stands, unchanged, not reopened by logout's arrival.
   - **Conclusion, stated plainly per the prompt's request: the existing adoption design remains
     correct as-is. No update to `adoptLegacyDataIfSafe`, its guest-vs-stranded heuristic, or its
     idempotency signal is required as part of building logout.**

6. Minor, unchanged from 2026-09-10: Logout button styling/placement and whether it needs a
   confirmation dialog — a normal product decision, not a risk.

### Production Supabase / live-write scope check

Per standing rule, flagging explicitly: **this investigation required no live writes and proposes
none.** The RLS-policy claim in §2 was verified by reading the actual migration SQL
(`supabase/migrations/20260819140001_rls_policies.sql`), not by a live query. Everything else above
is client-side code tracing (`storage.js`, `App.jsx`, `LaunchOverlay.jsx`) and reasoning about
already-shipped, already-verified behavior. Building logout itself will need
`supabase.auth.signOut()` verified against a real session (the existing `TEST_FIXTURE_KEEP`
fixture per CLAUDE.md, or a fresh throwaway for a two-different-accounts-on-one-device
verification of risk #1 specifically) — that live verification is out of scope for this
investigation-only pass and needs its own before-not-after confirmation when build work starts,
per the standing live-write rule. The same applies to any live check of risk #1's proposed fix
once it's built — a genuine `valid(A) → valid(B)` race is exactly the kind of scenario that would
need a real two-account live test to confirm closed, not just a mocked one.
