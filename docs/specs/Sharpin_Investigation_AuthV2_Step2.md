# Sharpin Investigation: Auth V2 Step 2 (Client Auth UI)

**Date:** 2026-10-10
**Type:** Read-only. No code changes, no commits, no Supabase calls, no `db query --linked`.
**Spec:** `docs/specs/Sharpin_Spec_AuthV2.md` (v2, D1–D17)
**Repo state at investigation:** HEAD `61d9af9`, working tree clean.
**SDK:** `@supabase/supabase-js` 2.112.3, `@supabase/auth-js` 2.112.3 (read from `node_modules/.../package.json`).

Context supplied for this step (2026-10-10, not yet in CLAUDE.md): Resend SMTP is live (sender `Sharpin <no-reply@sharpin.somewhatextemporaneous.com>`). Templates link to the site root: confirm = `{SiteURL}/?token_hash=<hash>&type=email`, reset = `{SiteURL}/?token_hash=<hash>&type=recovery`. The client calls `verifyOtp({ token_hash, type })` on boot. No PKCE, no Vercel rewrite. Secure password change (A4) is ON.

---

## ⚠ Separator conflict (read first)

The task brief says D3 joins moves with "│" (U+2502). **The spec, CLAUDE.md, the code, and the fixture's stored hash all use ASCII `|` (U+007C).**

`docs/specs/Sharpin_Spec_AuthV2.md:32` (the table escapes the pipe as `\|`):
```
| D3 | The password is the lowercase hex SHA-256 of the 4 moves, joined in order with `\|`.  ...
```
`docs/specs/Sharpin_Spec_AuthV2.md:51`:
```
- Client sends `sha256_hex(moves.join('|'))` as the password.  The raw sequence never leaves the device.
```
Byte dump of those two lines (`od -c`) shows `' | '` = 0x7C, not the 3-byte `342 224 202` sequence for U+2502:
```
0000200   x   (   m   o   v   e   s   .   j   o   i   n   (   '   |   '
```
`src/components/SequenceBoardInput.jsx:105` (confirmed by grep):
```js
const hash = await hashSequence(finalMoves.join('|'))
```
Local computation for the fixture's sequence (Node `crypto`, no network):
```
"c2c4|b2b4|a1a2|g1g2" U+007C utf8 bytes 19 6236db405f89…
"c2c4│b2b4│a1a2│g1g2" U+2502 utf8 bytes 25 32169a0aa1aa…
reversed "g1g2|a1a2|b2b4|c2c4" f29b571b9711…
```
Comparison against the gitignored pre-migration backup `backups/2026-10-09-pre-auth-v2/profiles.json`. The script printed booleans only, never hash values:
```
TEST_FIXTURE_KEEP | matches ASCII-pipe hash: true | matches U+2502 hash: false
Tee_Eye_Gee | matches ASCII-pipe hash: false | matches U+2502 hash: false
```
(Tee_Eye_Gee is a different sequence, so it should not match either. That result is expected.)

**Consequence:** D8 says TEST_FIXTURE_KEEP "keeps its existing hash as its password." That only works with ASCII `|`. Switching to U+2502 would break the fixture migration and change every hash. This investigation assumes ASCII `|` throughout; see open question Q1.

---

## 1. V1 auth UI inventory

### Components, hooks, call sites

| Item | Location | Status under V2 |
|---|---|---|
| `LaunchOverlay` (menu / login / create / migration prompt) | `src/components/LaunchOverlay.jsx` | **Keep shell; rewrite handlers** |
| `VIEWS` enum | `LaunchOverlay.jsx:7` | Extend |
| `migrateGuestDataToAccount(userId)` | `LaunchOverlay.jsx:58-122` | **Reuse as-is** |
| `handleLogin(hash)` → `verify-move-sequence` | `LaunchOverlay.jsx:173-198` | **Remove** |
| `handleCreateAccount(hash)` → `create-account` | `LaunchOverlay.jsx:200-271` | **Remove** (replace with `signUp`) |
| `handleMerge` / `handleDiscard` | `LaunchOverlay.jsx:273-296` | **Reuse**; move to wherever "first sign-in" is detected |
| Create-view display-name input + live validation | `LaunchOverlay.jsx:160, 298-305, 367-381` | **Reuse** |
| `SequenceBoardInput` | `src/components/SequenceBoardInput.jsx` | **Reuse unchanged** (see §5) |
| `App.saveDisplayName` → `update-profile` | `src/App.jsx:370-382` | **Reuse** (also for D5 first-sign-in name) |
| `App.handleLogout` | `src/App.jsx:420-431` | Step 3 territory; note the `signOut()` scope bug in §4 |
| Settings `AccountSection`, "Change sequence — coming soon" | `src/components/SettingsPanel.jsx:85-122` (placeholder `:94-103`) | **Replace placeholder** |
| `ACCOUNT_SYNC_ENABLED` flag | `src/App.jsx:28`, `src/utils/storage.js:8` | **Keep** |

### Raw excerpts: the V1 calls to remove

`src/components/LaunchOverlay.jsx:173-198`:
```js
  async function handleLogin(hash) {
    resetFormState()
    setSubmitting(true)
    const { data, error: invokeError } = await supabase.functions.invoke('verify-move-sequence', {
      body: { moveSequenceHash: hash },
    })
    setSubmitting(false)
    ...
    if (!data.match) {
      ...
      setError('Sequence not recognized -- try again.')
      return
    }

    const { data: setSessionData, error: setSessionError } = await supabase.auth.setSession(data.session)
    ...
    onAuthenticated(setSessionData.session)
  }
```
`src/components/LaunchOverlay.jsx:213-231`:
```js
    const { data, error: invokeError } = await supabase.functions.invoke('create-account', {
      body: { moveSequenceHash: hash, displayName: displayNameToSend },
    })

    if (invokeError) {
      setSubmitting(false)
      ...
      const status = invokeError.context?.status
      if (status === 409) {
        setError('That sequence is already in use -- choose another.')
      } else if (status === 429) {
        setRateLimited(true)
      } else {
        setError('Something went wrong -- try again.')
      }
      return
    }
```
The 409 "already in use" branch must go (D4). The 429 branch shape (`rateLimited` state plus the `:389` message) can be reused; only the detection changes (see §8).

### `move_sequence_hash` / `moveSequenceHash`

Grep across `src`, `supabase/functions`, configs, `index.html`, and `package.json`:
```
src/components/LaunchOverlay.jsx:177:      body: { moveSequenceHash: hash },
src/components/LaunchOverlay.jsx:214:      body: { moveSequenceHash: hash, displayName: displayNameToSend },
```
There are no other client references. The column is already dropped server-side (`supabase/migrations/20261009170000_auth_v2.sql`, step 1). Stale comments referencing the retired functions remain in `supabase/functions/update-profile/index.ts:5, :30-31, :76` and `supabase/functions/_shared/validate-display-name.ts:3`. Those are comment-only cleanup, optional.

### `VITE_ENABLE_ACCOUNT_SYNC` gating

`src/App.jsx:23-28`:
```js
// Feature flag gating all of Stage 3's account/sync UI (backlog #1).
// Default OFF: unset, or any value other than the literal string 'true',
// disables it ...
const ACCOUNT_SYNC_ENABLED = import.meta.env.VITE_ENABLE_ACCOUNT_SYNC === 'true'
```
Gate points: `App.jsx:84` (initial `sessionStatus` = `'disabled'`), `:158` (boot skips `getSession()`), `:175`, `:232` (`runSyncSequence` no-op); `storage.js:8, :46, :279, :395, :702, :789, :918`. Tests stub it: `vitest.config.js:14` defaults to `'true'`; `App.bootReadiness.test.jsx:33`, `usePuzzleEngine.raceB.realtiming.test.jsx:56`, and `storage.identity.flagOff.test.js:21` force `'false'`.

**Requirement for step 2:** URL-token handling (`verifyOtp`) and any `onAuthStateChange` subscription must sit **behind this flag**, preserving the "flag off means zero Supabase traffic" invariant (`App.jsx:132-134`). Consequence: while production has the flag off, a confirm/reset link that lands on prod does nothing. See risk R2.

---

## 2. Supabase client init

`src/lib/supabaseClient.js` (entire file):
```js
import { createClient } from '@supabase/supabase-js'

// Single shared client instance for the whole app. Session storage is left
// at supabase-js's default (localStorage) -- no custom storage adapter
// (locked decision, Sub-build B1: don't build one).
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
```
No options are passed, so the defaults apply. `node_modules/@supabase/supabase-js/src/lib/constants.ts:40-45`:
```ts
export const DEFAULT_AUTH_OPTIONS: SupabaseAuthClientOptions = {
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: true,
  flowType: 'implicit',
}
```
`node_modules/@supabase/auth-js/src/GoTrueClient.ts:199-204` agrees (storageKey `STORAGE_KEY`, `persistSession: true`, `detectSessionInUrl: true`, `flowType: 'implicit'`). Storage is localStorage, key `sb-wrexmksxphqkanrzzvcd-auth-token` (as seen in CLAUDE.md's JWT-decode snippet).

### Will any default intercept or ignore `?token_hash`?

**No interception.** Detection runs in `_initialize()` (`GoTrueClient.ts:650-662`):
```ts
      if (isBrowser()) {
        params = parseParametersFromURL(window.location.href)
        if (this._isImplicitGrantCallback(params)) {
          callbackUrlType = 'implicit'
        } else if (await this._isPKCECallback(params)) {
          callbackUrlType = 'pkce'
        }
      }
```
`GoTrueClient.ts:3969-3984`:
```ts
  private _isImplicitGrantCallback(params: { [parameter: string]: string }): boolean {
    ...
    return Boolean(
      params.access_token || params.error || params.error_description || params.error_code
    )
  }
  ...
  private async _isPKCECallback(params: { [parameter: string]: string }): Promise<boolean> {
    if (!params.code) {
      return false
    }
```
`token_hash` and `type` match neither condition, so `callbackUrlType` stays `'none'`. The SDK falls through to `_recoverAndRefresh()` (`:718-719`) and does not touch or strip the URL.

**Implication: the SDK ignores `?token_hash`, so the app must handle it.** There is one edge: if GoTrue ever redirects with `?error=…&error_code=…` (for example, an expired link sent through a server-side `/verify` URL), `detectSessionInUrl` will treat it as an implicit callback and return an error from initialize. With the templates as described (site root plus `token_hash`, verified client-side), GoTrue never redirects, so this should not occur.

### What must change

- **Nothing is strictly required in `createClient` options.** Implicit flow plus `detectSessionInUrl: true` is harmless for `token_hash` links.
- Optional hardening: `detectSessionInUrl: false`, since nothing in V2 uses URL-fragment sessions. That removes the error-param edge above. It is not required; leave it to Tiggs (Q8).
- Keep `persistSession: true` (default). D14/D6 logic assumes a localStorage session.
- Do **not** switch to `flowType: 'pkce'`. The brief rules it out, and PKCE would make `resetPasswordForEmail`/`signUp` emit `code_challenge` (`GoTrueClient.ts:1022`, `:4452-4456`), tying links to the originating browser and breaking the "works in any browser" requirement (spec §5).

---

## 3. Boot sequence

### Current boot

`src/App.jsx:153-188`:
```js
  useEffect(() => {
    let cancelled = false

    async function boot() {
      let identity
      if (!ACCOUNT_SYNC_ENABLED) {
        identity = GUEST_IDENTITY
      } else {
        const { data } = await supabase.auth.getSession()
        if (cancelled) return
        identity = data.session ? data.session.user.id : GUEST_IDENTITY
        if (data.session) setSession(data.session)
      }

      await adoptLegacyDataIfSafe(identity)
      if (cancelled) return

      setSessionStatus(!ACCOUNT_SYNC_ENABLED ? 'disabled' : identity === GUEST_IDENTITY ? 'none' : 'valid')
      if (identity === GUEST_IDENTITY) setReadyIdentity(GUEST_IDENTITY)

      await loadAndApplyPreferences()
    }

    boot()
    return () => { cancelled = true }
  }, [loadAndApplyPreferences])
```
`src/main.jsx` renders under `<StrictMode>`:
```js
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

### Where to parse `token_hash`/`type`

**Not inside the React effect.** Under StrictMode (dev), the boot effect mounts, unmounts, and remounts, so `boot()` runs twice. The first run is only "cancelled" after its `await`; it is not prevented from starting. A `verifyOtp` placed inside `boot()` would fire twice. Email OTP token hashes are single-use, so the second call would fail (`otp_expired`), and depending on ordering the UI could show an error even though the first call succeeded.

Recommended approach: a module-level, run-once consumer (e.g. a new `src/lib/authUrl.js`, or inside `supabaseClient.js`):
1. At module evaluation, read `new URLSearchParams(location.search)`. If `token_hash` and `type` are present, capture them in memory and **immediately** `history.replaceState(null, '', location.pathname + remainingSearch + location.hash)` to strip both params, keeping any others.
2. Export a memoised `consumeUrlToken()` promise: `await supabase.auth.initialize()` → `supabase.auth.verifyOtp({ token_hash, type })` → resolve `{ type, ok, error, session }`. Called once regardless of how many times React mounts.
3. `boot()` awaits that promise (only when `ACCOUNT_SYNC_ENABLED`) **before** its `getSession()` call. This matches spec §5 ("calls `verifyOtp` at boot, before `getSession()`").

Why `await supabase.auth.initialize()` first: auto-init starts in the constructor (`GoTrueClient.ts:547-548`), and `initialize()` returns the same promise (`:606-609`):
```ts
  async initialize(): Promise<InitializeResult> {
    if (this.initializePromise) {
      return await this.initializePromise
    }
```
`verifyOtp` itself does **not** await `initializePromise` (`GoTrueClient.ts:2458-2468`; compare `updateUser` at `:3384` and `signOut` at `:4044`, which do). If verifyOtp ran while `_recoverAndRefresh()` was still refreshing a *previous* user's stored session, that refresh's `_saveSession` could land after verifyOtp's save and overwrite the new session. Awaiting `initialize()` first removes the race.

Why strip before verifying: a reload, or an in-app browser re-render, must not resubmit a consumed token. If verification fails, the user still has the email and can request another. The stripped values live only in memory.

`verifyOtp`'s session handling (`GoTrueClient.ts:2486-2492`):
```ts
      if (session?.access_token) {
        await this._saveSession(session as Session)
        await this._notifyAllSubscribers(
          params.type == 'recovery' ? 'PASSWORD_RECOVERY' : 'SIGNED_IN',
          session
        )
      }
```
So after it resolves, the boot's `getSession()` returns the new session, and the existing boot path (`identity = data.session.user.id`, `adoptLegacyDataIfSafe(identity)`, `setSessionStatus('valid')`) runs unchanged **for `type=email`**.

`EmailOtpType` includes `'email'` and `'recovery'` (`node_modules/@supabase/auth-js/src/lib/types.ts:889-896`):
```ts
export type EmailOtpType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'email'
  | (string & {})
```
Whitelist `type ∈ {'email', 'recovery'}` client-side and ignore anything else.

### Interaction with #1d readiness gating

The readiness contract (`App.jsx:31-38`, `:295-316`): guest readiness is set at boot; an account becomes ready only after `runSyncSequence` → `pullProfileStats` confirms it. The login trigger effect (`App.jsx:306-316`):
```js
  useEffect(() => {
    if (sessionStatus !== 'valid' || !session) return
    const uid = session.user.id
    let cancelled = false
    setReadyIdentity((prev) => (prev === uid ? prev : null))
    runSyncSequence().then(async (result) => {
      if (cancelled) return
      if (await confirmAccountReady(uid, result) && !cancelled) setReadyIdentity(uid)
    })
    return () => { cancelled = true }
  }, [sessionStatus, session, runSyncSequence, confirmAccountReady])
```
- **`type=email` (confirm):** the boot sees a session and sets `'valid'`; the effect above pulls stats and marks readiness. #1d needs nothing new. The only addition is the D11 first-sign-in check (§6), which must run **before** `setSessionStatus('valid')` so the Merge/Discard prompt appears before sync and readiness start. Otherwise `runSyncSequence` → `flushUnsyncedAttempts` would run first. That is safe because unsynced guest rows are owner-pinned to `'guest'` by #1e, but the ordering would differ from V1's Merge path.
- **`type=recovery`:** the session is real and in localStorage, so `storage.resolveIdentity()` (`storage.js:45-49`) already resolves to that user:
  ```js
  async function resolveIdentity() {
    if (!ACCOUNT_SYNC_ENABLED) return GUEST_IDENTITY
    const { data: { session } } = await supabase.auth.getSession()
    return session ? session.user.id : GUEST_IDENTITY
  }
  ```
  The boot must **not** set `'valid'` (see §4). It should hold `readyIdentity = null` (board shows "Loading puzzle…") while the recovery view is up. The #1d commit guard (`usePuzzleEngine.js:259-260`) already refuses commits when readiness and the live session disagree:
  ```js
    if (gatedRef.current && readyIdentityRef.current !== identity) return
    if ((await getActiveIdentity()) !== identity) return
  ```
  so no guest attempt can be written under the recovered user meanwhile.
  `adoptLegacyDataIfSafe` must still run exactly once. Run it with the **guest** identity if the user cancels recovery, or with the account uid once recovery completes. Simplest: in recovery mode, defer adoption until the recovery view resolves, and do not set `sessionStatus` away from `'checking'` until then. That preserves the boot comment's guarantee at `App.jsx:134-138`.

### Interaction with reload-on-user-change (D12)

D12 is implemented as an in-memory state change, not a page reload (`App.jsx:142-152`, plus the Gate Step 0 note in CLAUDE.md). Two new in-page user changes appear in step 2:
1. **Interactive sign-in** (`signInWithPassword` in LaunchOverlay) → `onAuthenticated(session)` → `setSession` + `setSessionStatus('valid')` (`App.jsx:460-464`). This is the same path V1 used, so #1d handles it.
2. **Recovery completed** (`updateUser` succeeds in the recovery view) → same `onAuthenticated`-style transition into `'valid'`.

Kill-switch §9 (full reload after login, logout, or recovery) stays available. After `replaceState`, a reload is clean because the token is gone from the URL.

---

## 4. `onAuthStateChange`: current handling and recovery isolation

**There is no `onAuthStateChange` subscription anywhere in `src/`.** Grep for `onAuthStateChange|verifyOtp|resetPasswordForEmail|signInWithPassword|updateUser|signUp` across `src` returns no call sites. The only matches are `signOut` (`App.jsx:423`) and test mocks. All session transitions today are imperative:
- Boot: `getSession()` (`App.jsx:161`).
- Login and create: `onAuthenticated(session)` from LaunchOverlay (`App.jsx:460-464`).
- Logout: `handleLogout` (`App.jsx:420-431`).

So `SIGNED_IN`/`SIGNED_OUT` events are currently ignored entirely. Storage functions independently re-read the live session through `getSession()`.

### Event emission in auth-js (what a subscriber would see)

| Call | Event | Source |
|---|---|---|
| `signUp` (confirm ON → no session) | none | `GoTrueClient.ts:1067-1070` (`if (data.session) { … 'SIGNED_IN' }`) |
| `signInWithPassword` | `SIGNED_IN` | `:1255-1258` |
| `verifyOtp` type=email | `SIGNED_IN` | `:2488-2491` |
| `verifyOtp` type=recovery | **`PASSWORD_RECOVERY`** | `:2488-2491` |
| `updateUser` | `USER_UPDATED` | `:3433-3435` |
| `signOut` local/global | `SIGNED_OUT` | `:5247` |
| `signOut({scope:'others'})` | none (types.ts doc: "When using others, there is no sign-out event fired") | `types.ts:1876-1884` |

Subscriber registration replays `INITIAL_SESSION` after init (`GoTrueClient.ts:4316-4330`). Events are also broadcast to other tabs through `BroadcastChannel(storageKey)` (`:516-518`).

### Keeping a recovery session from being treated as a login (v20 §2.4)

The spec requires this in §5 ("The app must not treat a recovery session as a normal login. It shows a 'draw your new sequence twice' view outside LaunchOverlay"). Because the app is imperative, not event-driven, **the decision belongs in the boot path, using `consumeUrlToken()`'s returned `type`**, not in an event handler:

```
boot():
  urlResult = await consumeUrlToken()        // flag-gated
  if urlResult?.type === 'recovery' && urlResult.ok:
      setRecoveryPending(urlResult.session)  // new App state
      // do NOT setSession / setSessionStatus('valid'); readiness stays null
      return (or park, see §3 adoption note)
  ...existing getSession() path...
```

There is a gap this leaves open, which is the more important risk. **The recovery session is already persisted to localStorage when `verifyOtp` returns.** If the user closes the tab before setting a new sequence, the next boot's `getSession()` returns it, and the app treats it as a normal signed-in session: full login, no new sequence set. To close the gap, persist a small marker (for example `localStorage['sharpin-recovery-pending'] = uid`, set immediately after a recovery `verifyOtp` succeeds and cleared after `updateUser` succeeds or the user cancels). On boot, if the marker matches the stored session's uid, re-enter the recovery view. Alternatively, on cancel or abandonment, call `signOut({ scope: 'local' })`. Whether an abandoned recovery should leave the user signed in is a product call (Q4).

An optional `onAuthStateChange` listener for `PASSWORD_RECOVERY` is **not needed** for the same-tab path and would duplicate it. It would only matter for the cross-tab case (R5).

### Logout scope bug spotted (step 3 scope, flagged now)

`src/App.jsx:423`:
```js
    await supabase.auth.signOut()
```
The default scope is **global**. `GoTrueClient.ts:4043`:
```ts
  async signOut(options: SignOut = { scope: 'global' }): Promise<{ error: AuthError | null }> {
```
D14 requires `signOut({ scope: 'local' })`. Today, logging out on one device signs every device out. This belongs to step 3 (logout), but it is a one-line fix and AC7 ("other devices stay signed in") will fail without it.

---

## 5. Sequence capture and hashing

### The existing 4-move board

`src/components/SequenceBoardInput.jsx`: fixed position, no legality, exactly 4 drags, auto-submits on the 4th. Line numbers below are file lines.

`:9` / `:10`:
```js
const START_FEN = 'rnb1kb1r/p2p1ppp/5n2/1p3Nq1/4PpP1/3P4/PPP4P/RNBQ1KR1 w kq - 0 12'
const SEQUENCE_LENGTH = 4
```
Hash function, `:43-47`:
```js
// Carried over unchanged from the placeholder this component replaces.
async function hashSequence(raw) {
  const data = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
```
Move capture and submit, `:104-126`:
```js
  async function submitSequence(finalMoves) {
    const hash = await hashSequence(finalMoves.join('|'))
    onSequenceComplete(hash)
  }

  function handlePieceDrop(sourceSquare, targetSquare, piece) {
    if (!canInteract) return false
    ...
    const nextMoves = [...moves, `${sourceSquare}${targetSquare}`]
    ...
    if (nextMoves.length === SEQUENCE_LENGTH) {
      submittedRef.current = true
      submitSequence(nextMoves)
    }
```
Promotion is disabled, `:152`: `onPromotionCheck={() => false}`.

### Exact move string format

Each move is `from` + `to` squares, lowercase algebraic, no separator, no piece letter, no promotion suffix: `c2c4`. The four are joined in drag order with ASCII `|`:
```
c2c4|b2b4|a1a2|g1g2        (TEST_FIXTURE_KEEP, from CLAUDE.md "Test fixtures")
```
SHA-256 of the UTF-8 bytes produces 64 lowercase hex chars. That satisfies the dashboard's minimum length of 64 and "Required characters: none" (CLAUDE.md, Auth dashboard config).

### Hash vs D3

| D3 requirement | Current code | Match |
|---|---|---|
| SHA-256 | `crypto.subtle.digest('SHA-256', …)` | ✓ |
| lowercase hex | `b.toString(16).padStart(2,'0')` (toString(16) is lowercase) | ✓ |
| moves joined in order | `finalMoves.join(...)` in drag order | ✓ |
| separator | ASCII `\|` | ✓ per spec; ✗ if the brief's U+2502 is intended (see top) |

Order sensitivity: reversed `g1g2|a1a2|b2b4|c2c4` hashes to `f29b571b9711…` versus `6236db405f89…`, which is consistent with AC3.

**Recommendation:** keep `hashSequence` unchanged so existing hashes (the fixture, D8) stay valid. Optionally extract it to `src/utils/sequenceHash.js` so tests can call it directly, with a test vector pinned to the fixture's sequence.

### Draw-twice confirmation: feasible without modifying the component

The component fires `onSequenceComplete(hash)` once per mount (`submittedRef`, `:78`). It resets itself only on a `disabled` true→false edge (`:89-97`). For draw-twice, the parent:
1. Renders `<SequenceBoardInput key="first" …/>` and stores `firstHash` on complete.
2. Swaps to `<SequenceBoardInput key="confirm" …/>`. The new `key` forces a fresh mount and an empty board, so no internal changes are needed.
3. On the second hash: equal → proceed; unequal → show "Sequences didn't match, draw it again", clear `firstHash`, and remount with `key="first-2"`.

Only hashes are compared, never raw moves, so the raw sequence still never leaves the component (spec §4). Needed for: signup, forgot-sequence (new), change-sequence (new).

Minor notes:
- The board ignores the app's Tap input mode (`inputMode`). It uses `onPieceDrop` only (`:151`). This is unchanged from V1.
- `crypto.subtle` exists only in secure contexts (https or localhost). Phone testing against a LAN-IP dev server (`http://192.168.x.x`) will throw. See R9.

---

## 6. Merge: existing guest-merge path and D11 first-sign-in detection

### Existing path

V1 triggered Merge/Discard immediately after `create-account` minted a session, from inside `handleCreateAccount`. `LaunchOverlay.jsx:251, :265-270`:
```js
    const existingAttempts = await getAllAttempts({ identity: GUEST_IDENTITY })
    ...
    if (existingAttempts.length > 0) {
      setPendingSession(setSessionData.session)
      setView(VIEWS.MIGRATION_PROMPT)
    } else {
      onAuthenticated(setSessionData.session)
    }
```
The migration itself (`LaunchOverlay.jsx:58-122`) is identity-explicit and idempotent, with a built-in "empty remote" pre-check at `:59-68`:
```js
async function migrateGuestDataToAccount(userId) {
  const { count: existingRemoteAttempts, error: existingCheckError } = await supabase
    .from('puzzle_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('profile_id', userId)
  ...
  if (!existingRemoteAttempts) {
    const localAttempts = await getAllAttempts({ identity: GUEST_IDENTITY })
```
It then calls `recompute_stats` (`:108`) and upserts preferences from the guest bucket (`:111-121`). Discard is `resetAllLocalData({ identity: GUEST_IDENTITY })` (`:293`). All of it is **reusable unchanged**. It only needs a valid session for `userId`.

### Why V1's trigger point no longer works

Under V2, `signUp` with confirmation ON returns **no session** (`GoTrueClient.ts:1067`: `if (data.session) {…}`). The session first appears either:
- (a) at `verifyOtp(type=email)` when the confirm link is clicked, possibly in a **different browser** (a phone's in-app mail browser) that has no guest data, or
- (b) at the first `signInWithPassword` on the device that has the guest data.

D2: "Guest data stays on the device until the user confirms." D11: "Merge/Discard is offered only when a new account first signs in." So the check must run **at every sign-in entry point** (boot after `verifyOtp` email, and interactive `signInWithPassword`), and must decide whether this account is new.

### Detecting "new account's first sign-in"

Candidate signals (none exists today):

| Signal | How | Pros | Cons |
|---|---|---|---|
| **A. Remote `puzzle_attempts` count = 0** | Same query as `migrateGuestDataToAccount:59-62` | No schema change; already the migration's own guard | An *existing* account with zero attempts counts as new. Merging into it is harmless (its rating is the 1200 default, and `recompute_stats` derives everything from deltas), but it technically deviates from D11. |
| **B. `user_metadata.guest_merge_resolved`** | Set via `updateUser({ data: { guest_merge_resolved: true } })` after Merge, Discard, or no-guest-data | One-shot per account; survives devices | Adds `USER_UPDATED` writes; metadata is user-writable (fine here); does **not** touch the password, so A4 is irrelevant |
| C. `profiles` column (e.g. `merge_offered_at`) | Migration | Server-authoritative | **Prod schema write**, out of step 2's gate |
| D. `user.created_at` ≈ `last_sign_in_at` | From session user | No writes | Fragile: `verifyOtp` itself sets `last_sign_in_at`, so the second-device sign-in no longer looks "first" |

**Recommendation: A AND B.** Offer Merge/Discard only when local guest attempts > 0, remote attempts = 0, and `user_metadata.guest_merge_resolved !== true`. Set the flag once the user resolves the prompt, or immediately when there was no guest history to offer. B prevents re-prompting forever on a long-idle account that later picks up guest history on another device; A guarantees we never insert into an account that already has history (the migration's own guard). Confirm with Tiggs (Q3).

Display name on first sign-in (spec §5): `signUp({ email, password, options: { data: { display_name } } })` stores it in `user_metadata` (`GoTrueClient.ts:1030`: `data: options?.data ?? {}`). On first sign-in, if `profiles.display_name` is null (the trigger inserts `(id)` only, per CLAUDE.md step 1) and `session.user.user_metadata.display_name` is set, call the existing `saveDisplayName` (`App.jsx:370-382`, which invokes `update-profile`). The client should validate before `signUp` (`validateDisplayName`, already used at `LaunchOverlay.jsx:210-211`), but `update-profile` remains the enforcement point.

Where the prompt lives: the Merge/Discard view needs the session to exist and must appear **before** `sessionStatus` becomes `'valid'`. For the boot path (confirm link), LaunchOverlay is not mounted, because App only renders it at `sessionStatus === 'none'` (`App.jsx:457`). So either:
- move `MIGRATION_PROMPT` into its own small component (`FirstSignInPrompt`), rendered by App from a new `pendingFirstSignIn` state, used by both the boot and interactive paths; or
- have the boot path force-mount LaunchOverlay in a `migration_prompt`-only mode.

The first is cleaner (§a).

---

## 7. Change sequence with A4 ON

### Same client: `signInWithPassword` then `updateUser`

`signInWithPassword` saves the new session into the shared client's storage (`GoTrueClient.ts:1255-1258`):
```ts
      if (data.session) {
        await this._saveSession(data.session)
        await this._notifyAllSubscribers('SIGNED_IN', data.session)
      }
```
`updateUser` then runs on whatever session is current via `_useSession` and sends that access token (`GoTrueClient.ts:3403-3425`):
```ts
      return await this._useSession(async (result) => {
        ...
        const session: Session = sessionData.session
        ...
        const { data, error: userError } = await _request(this.fetch, 'PUT', `${this.url}/user`, {
          ...
          body: {
            ...attributes,
            ...
          },
          jwt: session.access_token,
```
So on the single shared `supabase` instance, `await signInWithPassword({ email: session.user.email, password: currentHash })` followed by `await updateUser({ password: newHash })` sends the **just-minted** token. A4's "session must be recent (<24h)" requirement is satisfied by construction. This matches CLAUDE.md's client build note ("the `signInWithPassword` call that verifies the current sequence must also provide the session `updateUser` runs on").

Same-user caveats:
- The `session` object in App state goes stale (it has the old token). Update it with the returned session, or leave it alone: storage functions read the live session anyway, and `uid` is unchanged, so `setReadyIdentity((prev) => prev === uid ? prev : null)` (`App.jsx:310`) keeps readiness if the effect re-fires.
- A **wrong** current sequence returns `invalid_credentials` (`error-codes.ts:88`) and the stored session is **unchanged**, because `_saveSession` only runs on success (`:1249-1258`). That supports AC2.
- `updateUser` with the same hash as before → GoTrue error code `same_password` (`error-codes.ts:65`). Map it to "Your new sequence must be different."
- If A4 still rejects for any reason → `reauthentication_needed` (`error-codes.ts:64`). Handle it generically.

**Not verified live.** AC9 and the CLAUDE.md acceptance addition require a live run.

### Does D15 require an explicit `signOut({ scope: 'others' })`?

Server behavior is outside `node_modules` and could not be verified locally. From recollection of the supabase/auth (GoTrue) source, **unverified here**: the password-update path in `UserUpdate` calls `user.UpdatePassword(tx, &sessionID)`, which revokes all of the user's other sessions (`LogoutAllExceptMe`) whenever the password changes. If that holds, D15 is met server-side for both change and recovery.

**Recommendation: call `supabase.auth.signOut({ scope: 'others' })` explicitly anyway**, right after a successful `updateUser`:
- It makes D15 independent of server internals and dashboard settings.
- It is cheap and idempotent, and it does not touch the current session. `GoTrueClient.ts:4082-4089`:
  ```ts
        if (scope !== 'others') {
          await removeCurrentSession()
        }
  ```
- It fires no client event (`types.ts:1876-1884`), so it causes no App re-render churn.
- Treat a failure as non-fatal (log it and still report success), because the password has already changed.

Either way, **existing access tokens (JWTs) on other devices remain valid until they expire** (default 1h). Only their refresh tokens are revoked. AC8 ("other sessions signed out") will therefore show up on the other device at its next refresh or after up to an hour, not instantly. Plan the evidence capture around that (R6).

---

## 8. UI touchpoints

| Touchpoint | Where today | Step-2 change |
|---|---|---|
| **"Signed in as …" (D5)** | Nowhere. `Header` (`src/components/Header.jsx`) shows only the wordmark, mode toggle, and gear. `displayName` state exists (`App.jsx:95`, fetched at `:196-209`) | Show `displayName ?? session.user.email`. Suggested placement: the top of Settings → Account (always), plus a transient confirmation after sign-in. A persistent Header line is a visual change and needs sign-off (Q6). |
| **Sign in** | `LaunchOverlay` LOGIN view, `:352-361` (sequence only) | Add email input above the board. Failure text "Email or sequence not recognized" (spec §5) replaces "Sequence not recognized -- try again." (`:188`) |
| **Sign up** | CREATE view, `:363-394` | Add email (required); keep the display name; draw twice; then a "Check your email" state. No 409 branch. |
| **Forgot sequence** | None | A link under the sign-in board → email-only view → `resetPasswordForEmail(email)` → always "If that email has an account, a link is on its way." The resulting recovery view (draw new twice) lives **outside** LaunchOverlay (spec §5) |
| **Change sequence** | `SettingsPanel.jsx:94-103` placeholder: `Change sequence — coming soon` (disabled) | Replace with a button that opens a modal: draw current → draw new ×2 → done. Should be disabled while `puzzleAttemptInFlight`, same as Logout (`App.jsx:481`) |
| **429 messaging** | `LaunchOverlay.jsx:226-227, :389` (V1 detection via `invokeError.context?.status`) | Detection becomes `error.status === 429` or `error.code ∈ {'over_request_rate_limit','over_email_send_rate_limit'}` (`error-codes.ts:71-72`). Applies to sign-in, sign-up, forgot, change. Text stays "Too many attempts -- try again later." Note: for `signUp` and `resetPasswordForEmail`, an email-send limit **is** a 429 even though the screen otherwise always says "check your email". Show it, rather than silently claiming an email was sent. |
| **Email not confirmed** | None | `signInWithPassword` on an unconfirmed account returns `email_not_confirmed` (`error-codes.ts:47`). D17 accepts the leak. Suggested copy: "Confirm your email first. Check your inbox." (Q5) |
| **Settings → Account section** | `SettingsPanel.jsx:85-122`: display name, sequence placeholder, Logout; rendered only when `loggedIn` (`:203`) | Add the "Signed in as" line and a working Change sequence. Delete account is step 4, so leave room for it. |

Rate-limit config context (CLAUDE.md): sign-ups/sign-ins 30 per 5 min; D13 wants `/token` at 30 per 5 min, and the dashboard notes say it is currently 150. That is a step-1/config item, not client work, but AC11 depends on it.

The `DisplayNameFields` mount race (CLAUDE.md backlog) will look more prominent once "Signed in as" shows the same `displayName`. It is not in scope, but noted.

---

## 9. Test infrastructure

### How auth is mocked today

All tests mock `supabaseClient` at the module boundary with hand-written objects. Nothing exercises real auth-js except the storage fixture test.

`src/components/LaunchOverlay.migration.test.jsx:17-58`. The board is stubbed to a button that emits `'fake-hash'`, and auth is `getSession`/`setSession` plus `functions.invoke`:
```js
vi.mock('./SequenceBoardInput', () => ({
  default: ({ onSequenceComplete, disabled }) => (
    <button disabled={disabled} onClick={() => onSequenceComplete('fake-hash')}>
      complete-sequence
    </button>
  ),
}))
...
let currentSession = null
const mockGetSession = vi.fn(() => Promise.resolve({ data: { session: currentSession } }))
const mockSetSession = vi.fn((session) => {
  currentSession = { ...session, user: { id: 'acct-1' } }
  return Promise.resolve({ data: { session: currentSession }, error: null })
})
const mockFunctionsInvoke = vi.fn()
...
vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: (...a) => mockGetSession(...a), setSession: (...a) => mockSetSession(...a) },
    functions: { invoke: (...a) => mockFunctionsInvoke(...a) },
    rpc: (...a) => mockRpc(...a),
    from: (table) => fromMock(table),
  },
}))
```
Its 5 tests (`:113, :130, :155, :186, :205`) all drive Create Account through `functions.invoke('create-account')` and `setSession`. **All five must be rewritten** (spec §6 already says so). The Merge and Discard storage assertions themselves carry over.

`src/App.userChange.test.jsx:55-79`. Auth is `getSession` and `signOut` only. LaunchOverlay is stubbed to a `stub-login` button that flips `currentSession` and calls `onAuthenticated`:
```js
vi.mock('./lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: currentSession } }),
      signOut: () => { currentSession = null; return Promise.resolve({ error: null }) },
    },
    from: (table) => builder(table),
    rpc: () => Promise.resolve({ error: null }),
  },
}))
```
Its "session restored on page load (recovery-link sign-in)" test (`:254-275`) is based on a premise that no longer holds:
```js
    // A recovery (or any emailed) link opens a fresh page load: supabase-js
    // stores the session from the URL during client init, so App's boot
    // getSession() already returns it. That is the path this exercises.
```
That was true for implicit `#access_token` links. With `?token_hash`, the SDK does **not** store anything (§2), and a recovery session must **not** reach the account band at all (§4). Rewrite the test as a "restored normal session" case, and add new recovery-specific tests.

`src/App.bootReadiness.test.jsx:22-27` mocks only `auth.getSession` with the flag off. It is unaffected as long as the new URL/verify code is flag-gated and not called when the flag is off.

**Mock-surface breakage to expect:** any new top-level call (`supabase.auth.initialize`, `verifyOtp`, `onAuthStateChange`) reached on the flag-on path will throw `… is not a function` in `App.userChange.test.jsx` until its mock is extended. Keep the URL consumer a separate module (`src/lib/authUrl.js`) so tests can mock it directly.

Reminder from CLAUDE.md "Technical learnings": call-count assertions on `getSession()` do not transfer from mocks to live runs. Assert on outcomes instead.

### What spec §8 needs for step 2

Unit/jsdom (local, mocked boundary):
- `hashSequence` vector: `c2c4|b2b4|a1a2|g1g2` → the fixture's hash; the reversed order differs (AC3 at unit level).
- Draw-twice: match → proceeds; mismatch → reset, no network call.
- Sign-in: calls `signInWithPassword({ email, password: <hex> })`; `invalid_credentials` → generic message and no session change (AC2); 429 → rate-limit message (AC11).
- Sign-up: calls `signUp` with `options.data.display_name`; always shows the "check your email" state; never calls Merge.
- URL consumer: strips `token_hash`/`type` via `replaceState`; calls `verifyOtp` **once** even when App mounts twice (StrictMode); ignores unknown `type`; does nothing with the flag off.
- Boot with `type=email` and guest history → first-sign-in prompt appears **before** `sessionStatus` becomes `'valid'`; Merge moves guest rows (reuse the existing migration assertions; AC5 at unit level).
- Boot with `type=recovery` → recovery view, `readyIdentity` stays null, no account-band puzzle, no commit possible. Reloading with the pending marker returns to the recovery view.
- Existing account with remote attempts + guest history → no prompt; guest rows untouched (AC6 at unit level, plus the existing #1d guard tests).
- Change sequence: `signInWithPassword` then `updateUser` then `signOut({scope:'others'})`, in order; wrong current → stop, no `updateUser`; `same_password` → message.
- Logout calls `signOut({ scope: 'local' })` (if the step-3 fix lands with this step).

Live (dev, then prod smoke; each live write flagged before it runs, per gate notes and memory):
- AC1 (including a phone in-app browser), 2, 3, 4, 8, 9, 11. The CLAUDE.md additions: with A4 ON, change succeeds and reset succeeds.
- AC5 and AC6 need the step-3 logout cache-clear for their "after logout" halves.
- Accounts: plus-addressed Gmail (D16). TEST_FIXTURE_KEEP cannot sign in until step 5.
- Evidence format per spec §8: both viewports, raw console/IndexedDB/JWT-sub dumps.

---

## (a) Proposed component and flow design

**New and changed modules**
1. `src/lib/authUrl.js` (new). Runs once at module evaluation: parses `token_hash` and `type` (whitelist `email`/`recovery`) and strips them with `replaceState`. Exports `consumeUrlToken()`, a memoised promise that does `await supabase.auth.initialize()` then `verifyOtp`, resolving to `{ type, ok, session, error } | null`. A no-op when `ACCOUNT_SYNC_ENABLED` is false.
2. `src/utils/sequenceHash.js` (new, optional). `hashSequence` and `SEQUENCE_SEPARATOR = '|'` moved out of `SequenceBoardInput` with no behavior change.
3. `src/components/SequenceConfirmInput.jsx` (new). Wraps `SequenceBoardInput` with the `key`-remount draw-twice flow. `onConfirmed(hash)`. Used by sign-up, recovery, and change.
4. `LaunchOverlay.jsx`. Views: MENU / SIGN_IN (email + board, plus a "Forgot sequence?" link) / SIGN_UP (email, display name, `SequenceConfirmInput`) / CHECK_EMAIL / FORGOT (email). The `MIGRATION_PROMPT` view moves out. Removes both `functions.invoke` calls. Sign-in success → `onAuthenticated(session)`, unchanged contract.
5. `src/components/FirstSignInPrompt.jsx` (new). Merge/Discard UI plus `migrateGuestDataToAccount` (moved verbatim from LaunchOverlay). Rendered by App from `pendingFirstSignIn` state, for both the boot-confirm and interactive sign-in paths.
6. `src/components/RecoveryView.jsx` (new). A full-screen overlay outside LaunchOverlay: "Set a new sequence" → `SequenceConfirmInput` → `updateUser({ password })` → `signOut({ scope: 'others' })` → clear the pending marker → App transitions to `'valid'`. A Cancel option (behavior per Q4).
7. `src/components/ChangeSequenceDialog.jsx` (new). Opened from Settings → Account: draw current (`signInWithPassword` with `session.user.email`) → `SequenceConfirmInput` → `updateUser` → `signOut({ scope: 'others' })` → "Sequence changed."
8. `App.jsx`
   - `boot()`: `const url = ACCOUNT_SYNC_ENABLED ? await consumeUrlToken() : null` before `getSession()`. A recovery result, or the persisted marker → `setRecovery(...)`, then return without setting `'valid'`; adoption is deferred until recovery resolves. Otherwise the existing path, plus a `checkFirstSignIn(session)` before `setSessionStatus('valid')`.
   - A shared `enterAccount(session)` helper used by boot, `onAuthenticated`, recovery completion, and FirstSignInPrompt completion: runs the first-sign-in check, applies the display-name-from-metadata fix-up, then `setSession` and `setSessionStatus('valid')`. This is the single funnel into #1d's login trigger.
   - `handleLogout`: `signOut({ scope: 'local' })` (D14). Strictly step 3, but it is a one-liner (Q7).
   - No `onAuthStateChange` subscription in step 2. Imperative transitions keep the existing #1d ordering guarantees. Cross-tab sync is deferred (R5).
9. `SettingsPanel.jsx` AccountSection: a "Signed in as {displayName ?? email}" line; a working Change sequence button; Logout unchanged.
10. Error mapping helper (e.g. `src/utils/authErrors.js`): `invalid_credentials` → "Email or sequence not recognized"; `email_not_confirmed` → confirm-first copy; `over_request_rate_limit` / `over_email_send_rate_limit` / status 429 → "Too many attempts -- try again later."; `same_password` → "Choose a different sequence"; `otp_expired` → "That link has expired or was already used. Request a new one."; default → "Something went wrong -- try again."

**Flows (summary)**
- Sign up: email + name + draw ×2 → `signUp({ email, password: hash, options: { data: { display_name } } })` → CHECK_EMAIL (always, unless 429).
- Confirm link: boot → `verifyOtp(email)` → `enterAccount` → first-sign-in check → (prompt) → `'valid'` → #1d sync → ready.
- Sign in: email + draw → `signInWithPassword` → `enterAccount`.
- Forgot: email → `resetPasswordForEmail(email)` → generic "sent" → link → boot `verifyOtp(recovery)` → RecoveryView → `updateUser` → `signOut(others)` → `enterAccount`.
- Change: Settings → dialog as above. Same uid, so #1d readiness is preserved.

---

## (b) Risks

- **R1. Separator mismatch (U+2502 vs `|`).** Adopting U+2502 changes every hash and breaks D8's fixture password reuse (proven above). It must be resolved before any code is written.
- **R2. Templates use `{SiteURL}`, so dev links land on production.** Site URL is `https://sharpin-your-game.vercel.app` (CLAUDE.md). Confirm and reset emails triggered from `localhost` will open the **production** app, where `VITE_ENABLE_ACCOUNT_SYNC` is off. There, `consumeUrlToken` must be a no-op (zero-traffic invariant), so the link appears to do nothing. Because the token is only consumed by a client `verifyOtp` POST, it stays valid, and a tester can hand-copy `?token_hash=…&type=…` onto `http://localhost:<port>/`. Alternatives: templates using `{{ .RedirectTo }}` plus `emailRedirectTo`/`redirectTo: location.origin` (the redirect allowlist already covers `localhost:*`), or temporarily enabling the flag in prod (Q2).
- **R3. StrictMode double-run consumes the single-use token.** If `verifyOtp` lives inside the boot effect, the dev build calls it twice and the second call fails. Mitigated by the module-level memoised consumer.
- **R4. An abandoned recovery becomes a full login.** `verifyOtp(recovery)` persists the session before a new sequence is set. Without a persisted marker or a sign-out on cancel, closing the tab and reopening the app yields a normal signed-in session via `getSession()`. Mitigation is in §4; the decision is Q4.
- **R5. Cross-tab session changes are unobserved.** auth-js shares localStorage and broadcasts on `BroadcastChannel` (`GoTrueClient.ts:516-518`). A recovery or sign-in in tab B changes what tab A's `storage.resolveIdentity()` returns, while tab A's App state still says otherwise. The #1d commit guard (`usePuzzleEngine.js:259-260`) blocks wrong-identity commits, so this is not corruption, but tab A's UI can be stale or stuck. This was already true for V1 login and logout; recovery links make it likelier (the link opens a new tab on the same device). Defer; consider a later `onAuthStateChange` listener that reloads on uid mismatch (the kill-switch fallback).
- **R6. D15 timing.** Other devices keep a valid access token until expiry (~1h), even after their refresh tokens are revoked. AC8 evidence needs a wait or a forced refresh. Server-side auto-revocation on password change is from recollection only (§7); the explicit `signOut({scope:'others'})` covers it.
- **R7. Logout is currently global (`App.jsx:423`).** It violates D14/AC7 until fixed.
- **R8. First-sign-in heuristic edge.** With signal A alone, a confirmed-but-never-played existing account would be offered Merge on another device. That is harmless in outcome, but it is not literally D11. Signal B closes it.
- **R9. `crypto.subtle` requires a secure context.** Phone testing against an `http://<LAN-IP>` dev server will fail at hashing (and auth links would not redirect there anyway). Use a tunnel or https dev, or test phones against prod.
- **R10. In-app email browsers.** The confirm link may open in an isolated webview (Gmail or Outlook in-app). The account gets signed in **there**, not in the user's main browser. The main browser then needs an ordinary sign-in, which is where the first-sign-in Merge offer must fire (hence detection at every entry point, §6). Link scanners that pre-fetch URLs are harmless, because a GET of the site root does not consume the token; only the client POST does.
- **R11. Test-mock churn.** All five `LaunchOverlay.migration` tests and the `App.userChange` recovery test need rewriting, and new auth methods will break existing mocks on the flag-on path.
- **R12. Email-send rate limits.** `signUp` and `resetPasswordForEmail` can return `over_email_send_rate_limit`. "Always say check your email" must not swallow it, or users will wait for mail that never comes.

---

## (c) Open questions for Tiggs

- **Q1. Separator:** confirm D3 is ASCII `|` (U+007C) as written in the spec and code, and that U+2502 in the step-2 brief was a typo or rendering artifact. Recommendation: ASCII `|`; anything else breaks D8.
- **Q2. Dev link handling:** how should confirm and reset links be tested from dev, given the templates hardcode `{SiteURL}` (prod) and prod has the flag off? Options: (i) manually swap the host to localhost (no config change); (ii) switch the templates to `{{ .RedirectTo }}` and pass `emailRedirectTo`/`redirectTo` from the client (a dashboard config change on prod, needs approval); (iii) enable the flag in prod earlier.
- **Q3. First-sign-in detection:** approve "remote attempts = 0 AND `user_metadata.guest_merge_resolved` not set" (signals A + B)? Or A only?
- **Q4. Abandoned recovery:** if the user closes or cancels the "set new sequence" view, should they (a) be signed out locally (strict reading of "must not treat as a login"), or (b) stay signed in and be returned to the recovery view on the next load until they finish? Recommendation: (a) on explicit Cancel, (b) on tab close (marker).
- **Q5. Unconfirmed sign-in copy:** show a specific "Confirm your email first" for `email_not_confirmed` (D17 already accepts the leak), or keep the generic "not recognized"?
- **Q6. "Signed in as" placement:** Settings → Account only, or also a persistent line in the Header? The Header option is a visual change needing push sign-off.
- **Q7. Logout scope fix:** fold the one-line `signOut({ scope: 'local' })` (D14) into step 2, or keep it in step 3 as planned?
- **Q8. `detectSessionInUrl: false`:** set it as hardening (V2 never uses fragment sessions), or leave the default?
- **Q9. Change-sequence entry when the session is older than 24h:** none expected, because the `signInWithPassword` step always mints a fresh session. Should a failure at `updateUser` after a successful current-sequence check sign the user out, or just show an error and keep the new session? Recommendation: show the error and keep the session.

---

## Decisions (2026-10-10)

- Q1 Separator is ASCII "|" (U+007C). U+2502 in the brief was an error. hashSequence unchanged.
- Q2 Templates will switch to {{ .RedirectTo }} after this build (Tiggs, dashboard). Client passes emailRedirectTo = window.location.origin on signUp and resend. Research and report evidence (Supabase/GoTrue docs or source; cite URLs) on whether RedirectTo falls back to Site URL when no redirect is passed. Do not change templates.
- Q3 Offer Merge/Discard only if local guest attempts > 0 AND remote puzzle_attempts = 0 AND user_metadata.guest_merge_resolved !== true. Set guest_merge_resolved = true ONLY when the user chooses Merge or Discard. Never set it because the current device has no guest data (a confirm link opened in a phone's in-app browser must not suppress the later Merge offer on the device that has guest history).
- Q4 (2b) Recovery: Cancel signs out locally; reload with marker returns to the recovery view; marker cleared on uid mismatch and on logout.
- Q5 email_not_confirmed shows "Confirm your email first. Check your inbox." plus a "Resend confirmation email" button: auth.resend({ type: 'signup', email, options: { emailRedirectTo: origin } }). Approved scope addition.
- Q6 (2b) "Signed in as" in Settings → Account only.
- Q7 Logout uses signOut({ scope: 'local' }) in this build.
- Q8 createClient auth option detectSessionInUrl: false.
- Q9 (2b) updateUser failure after a correct current sequence: show error, keep session.
- Correction to §8: D13's 30/5min is the sign-ups/sign-ins limit (dashboard shows 30). The 150 is token refreshes, intended. No config change.

### Q2 evidence: what `{{ .RedirectTo }}` contains when no redirect is passed

Researched 2026-10-10 against the `supabase/auth` (GoTrue) source on GitHub, `master` branch. The hosted Supabase Auth version may lag `master`.

1. Template data. `RedirectTo` is the mailer's `referrerURL` argument, while `SiteURL` comes from config.
   https://github.com/supabase/auth/blob/master/internal/mailer/templatemailer/templatemailer.go
   ```go
   "RedirectTo":      referrerURL,
   "SiteURL":         m.cfg.SiteURL,
   ```
2. `referrerURL` is computed once per email in `sendEmail` and passed to every mail type.
   https://github.com/supabase/auth/blob/master/internal/api/mail.go
   ```go
   referrerURL := utilities.GetReferrer(r, config)
   err = mr.ConfirmationMail(r, u, otp, referrerURL, externalURL)
   err = mr.RecoveryMail(r, u, otp, referrerURL, externalURL)
   ```
   `signup.go` and `resend.go` both call `a.sendConfirmation(r, tx, user, flowType)`, which reaches `sendEmail` with the same request.
3. `GetReferrer` has a three-step fallback.
   https://github.com/supabase/auth/blob/master/internal/utilities/request.go
   ```go
   // try get redirect url from query or post data first
   reqref := getRedirectTo(r)
   if IsRedirectURLValid(config, reqref) {
       return reqref
   }
   // instead try referrer header value
   reqref = r.Referer()
   if IsRedirectURLValid(config, reqref) {
       return reqref
   }
   return config.SiteURL
   ```
4. Supabase docs say `{{ .RedirectTo }}` "Contains the redirect URL passed when `signUp`, `signInWithOtp`, `signInWithOAuth`, `resetPasswordForEmail` or `inviteUserByEmail` is called." They do not describe the fallback.
   https://supabase.com/docs/guides/auth/auth-email-templates. Related: https://supabase.com/docs/guides/auth/redirect-urls

**Answer:** yes, `RedirectTo` ends at Site URL, but **only after two other sources**:
- the explicit `redirect_to` (supabase-js sends `emailRedirectTo`/`redirectTo` as the `redirect_to` query param), if it is on the allowlist;
- otherwise the HTTP `Referer` header of the API request, if it is on the allowlist.

From a browser, supabase-js's `fetch` carries a `Referer` of the page origin under the default `strict-origin-when-cross-origin` policy. So a dev signup from `http://localhost:5173` would likely get `RedirectTo = http://localhost:5173/` even without `emailRedirectTo`; that is inferred and not verified live. Requests without a Referer, or with one that is not allowlisted, fall back to Site URL. Passing `emailRedirectTo: window.location.origin` explicitly (as built) makes the result deterministic. `window.location.origin` has no trailing slash, so the template should be written `{{ .RedirectTo }}/?token_hash=...` or `{{ .RedirectTo }}?token_hash=...` accordingly. Both resolve to the site root, but a Referer-derived value ends in `/`, which would yield `//?` with the first form. Worth choosing the template form with that in mind, or always passing the redirect (the client does).
