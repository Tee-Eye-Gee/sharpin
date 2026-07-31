import { BOARD_THEMES } from '../utils/theme'

export default function SettingsPanel({ boardTheme, onSelectBoardTheme, onClose }) {
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

        <h3 className="text-xs text-fg-muted uppercase tracking-widest font-medium mb-2">
          Board theme
        </h3>
        <div className="flex flex-col gap-2">
          {Object.entries(BOARD_THEMES).map(([id, option]) => {
            const isSelected = boardTheme === id
            return (
              <button
                key={id}
                onClick={() => onSelectBoardTheme(id)}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm text-left transition-all
                  ${isSelected ? 'border-accent text-fg' : 'border-border text-fg-muted hover:border-border-strong'}`}
              >
                <span className="flex h-6 w-6 flex-shrink-0 overflow-hidden rounded border border-border-strong">
                  <span className="w-1/2 h-full" style={{ backgroundColor: option.light }} />
                  <span className="w-1/2 h-full" style={{ backgroundColor: option.dark }} />
                </span>
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
