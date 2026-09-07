import { useState } from 'react'
import { BOARD_THEMES } from '../utils/theme'
import { validateDisplayName } from '../utils/validateDisplayName'

const INPUT_MODES = [
  { id: 'drag', label: 'Drag', description: 'Drag and drop pieces' },
  { id: 'tap', label: 'Tap', description: 'Tap a piece, then tap a destination' },
]

// Own local state for the input's live-typed value and save flow --
// SettingsPanel remounts fresh each time it opens (conditionally rendered
// in App.jsx), so initializing from the `displayName` prop at mount always
// reflects the latest saved value without needing a sync effect.
function ProfileSection({ displayName, onSaveDisplayName }) {
  const [value, setValue] = useState(displayName ?? '')
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState('')
  const [saved, setSaved] = useState(false)

  // Live, on every keystroke -- the spec's "immediate try again feedback"
  // layer. The Edge Function's own copy of these same checks (spec:
  // docs/specs/Sharpin_Spec_ProfileDisplayName.md) is the actual
  // enforcement point; serverError below only ever fires for cases this
  // client-side check somehow missed.
  const trimmed = value.trim()
  const clientValidation = validateDisplayName(trimmed)
  const clientError = clientValidation.ok ? '' : clientValidation.error
  const isUnchanged = trimmed === (displayName ?? '')
  const displayedError = clientError || serverError

  async function handleSave() {
    if (!clientValidation.ok) return // Save is already disabled in this case
    setServerError('')
    setSaved(false)
    setSaving(true)
    const result = await onSaveDisplayName(clientValidation.value)
    setSaving(false)
    if (!result.ok) {
      setServerError(result.error)
      return
    }
    setSaved(true)
  }

  return (
    <section>
      <h3 className="text-xs text-fg-muted uppercase tracking-widest font-medium mb-2">
        Profile
      </h3>
      <div className="flex flex-col gap-2">
        <label className="text-xs text-fg-muted" htmlFor="display-name-input">
          Display name (optional)
        </label>
        <input
          id="display-name-input"
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setServerError('')
            setSaved(false)
          }}
          disabled={saving}
          placeholder="e.g. ChessFan42"
          className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent disabled:opacity-50"
        />
        {displayedError && <p className="text-xs text-red-400">{displayedError}</p>}
        {saved && !displayedError && <p className="text-xs text-accent">Saved.</p>}
        <button
          onClick={handleSave}
          disabled={saving || isUnchanged || !clientValidation.ok}
          className="rounded-lg border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-accent transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  )
}

function OptionButton({ isSelected, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm text-left transition-all
        ${isSelected ? 'border-accent text-fg' : 'border-border text-fg-muted hover:border-border-strong'}`}
    >
      {children}
    </button>
  )
}

export default function SettingsPanel({
  boardTheme,
  onSelectBoardTheme,
  inputMode,
  onSelectInputMode,
  onClose,
  loggedIn,
  displayName,
  onSaveDisplayName,
}) {
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />

      <div className="fixed top-16 right-4 z-50 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface p-4 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-fg">Settings</h2>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="text-fg-muted hover:text-fg text-lg leading-none px-1"
          >
            &times;
          </button>
        </div>

        <section>
          <h3 className="text-xs text-fg-muted uppercase tracking-widest font-medium mb-2">
            Board Theme
          </h3>
          <div className="flex flex-col gap-2">
            {Object.entries(BOARD_THEMES).map(([id, option]) => (
              <OptionButton key={id} isSelected={boardTheme === id} onClick={() => onSelectBoardTheme(id)}>
                <span className="flex h-6 w-6 flex-shrink-0 overflow-hidden rounded border border-border-strong">
                  <span className="w-1/2 h-full" style={{ backgroundColor: option.light }} />
                  <span className="w-1/2 h-full" style={{ backgroundColor: option.dark }} />
                </span>
                {option.label}
              </OptionButton>
            ))}
          </div>
        </section>

        <div className="my-4 border-t border-border" />

        <section>
          <h3 className="text-xs text-fg-muted uppercase tracking-widest font-medium mb-2">
            Piece Movement
          </h3>
          <div className="flex flex-col gap-2">
            {INPUT_MODES.map((mode) => (
              <OptionButton
                key={mode.id}
                isSelected={inputMode === mode.id}
                onClick={() => onSelectInputMode(mode.id)}
              >
                <span className="flex flex-col gap-0.5">
                  <span>{mode.label}</span>
                  <span className="text-xs text-fg-muted">{mode.description}</span>
                </span>
              </OptionButton>
            ))}
          </div>
        </section>

        {loggedIn && (
          <>
            <div className="my-4 border-t border-border" />
            <ProfileSection displayName={displayName} onSaveDisplayName={onSaveDisplayName} />
          </>
        )}
      </div>
    </>
  )
}
