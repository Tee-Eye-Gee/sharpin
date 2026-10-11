// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import SettingsPanel from './SettingsPanel'

// jsdom has no layout, so this pins the classes that make the panel scroll
// inside the viewport (found live 2026-10-11: the logged-in panel ran off
// the bottom of the screen). The actual 375px / 1280px check is visual.

afterEach(() => cleanup())

function renderPanel(loggedIn) {
  render(
    <SettingsPanel
      boardTheme="tournament"
      onSelectBoardTheme={() => {}}
      inputMode="drag"
      onSelectInputMode={() => {}}
      onClose={() => {}}
      loggedIn={loggedIn}
      displayName={null}
      onSaveDisplayName={async () => ({ ok: true })}
      onLogout={() => {}}
      logoutDisabled={false}
    />,
  )
  // The heading's row sits directly inside the panel card.
  return screen.getByText('Settings').parentElement.parentElement
}

describe('SettingsPanel: fits the viewport', () => {
  it('caps its height below the header and scrolls its own content', () => {
    const panel = renderPanel(true)
    const classes = panel.className.split(/\s+/)
    console.log('[settings] panel classes:', panel.className)
    expect(classes).toContain('max-h-[calc(100dvh-5rem)]')
    expect(classes).toContain('overflow-y-auto')
    // Position and width unchanged.
    for (const c of ['fixed', 'top-16', 'right-4', 'z-50', 'w-72', 'max-w-[calc(100vw-2rem)]']) {
      expect(classes).toContain(c)
    }
    // The Account section (the tall part) is inside the scrolling panel.
    expect(panel.contains(screen.getByText('Logout'))).toBe(true)
  })
})
