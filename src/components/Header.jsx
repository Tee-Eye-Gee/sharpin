function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12h2.5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.5-2-3.5-2.4.6a7.6 7.6 0 0 0-1.7-1L14.8 3h-4l-.5 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-.6-2 3.5L6.2 11a7.5 7.5 0 0 0 0 2l-2 1.5 2 3.5 2.4-.6a7.6 7.6 0 0 0 1.7 1L10.8 21h4l.5-2.6a7.6 7.6 0 0 0 1.7-1l2.4.6 2-3.5-2-1.5z" />
    </svg>
  )
}

export default function Header({ appMode, onToggleMode, onOpenSettings }) {
  return (
    <header className="flex items-center justify-between px-4 py-3 border-b border-border">
      <h1 className="text-lg font-bold tracking-tight">
        <span className="text-accent">Sharp</span>
        <span className="text-fg">in</span>
      </h1>

      <div className="flex items-center gap-1">
        <button
          onClick={onToggleMode}
          aria-label={appMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-2 rounded-lg text-fg-muted hover:text-fg hover:bg-surface transition-all active:scale-95"
        >
          <SunIcon />
        </button>
        <button
          onClick={onOpenSettings}
          aria-label="Open settings"
          className="p-2 rounded-lg text-fg-muted hover:text-fg hover:bg-surface transition-all active:scale-95"
        >
          <GearIcon />
        </button>
      </div>
    </header>
  )
}
