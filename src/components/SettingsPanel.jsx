import { BOARD_THEMES } from '../utils/theme'

const INPUT_MODES = [
  { id: 'drag', label: 'Drag', description: 'Drag and drop pieces' },
  { id: 'tap', label: 'Tap', description: 'Tap a piece, then tap a destination' },
]

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
      </div>
    </>
  )
}
