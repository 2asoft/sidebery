import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { BgTab } from 'src/types'
import { getInitialNavigationPending, reopenTab } from 'src/services/tabs.bg'

function tab(): BgTab {
  return {
    id: 1,
    windowId: 1,
    index: 3,
    url: 'https://site1.com/page',
    title: 'Site 1',
    active: true,
    cookieStoreId: 'firefox-container-1',
    highlighted: true,
    hidden: false,
    incognito: false,
    isInReaderMode: false,
    lastAccessed: 0,
    pinned: false,
  }
}

describe('initial navigation state', () => {
  test('remains pending after an empty page completes', () => {
    const pending = getInitialNavigationPending(true, 'about:blank', 'complete')

    expect(pending).toBe(true)
  })

  test('remains pending while the entered URL starts loading', () => {
    const pending = getInitialNavigationPending(true, 'https://site1.com/page', 'loading')

    expect(pending).toBe(true)
  })

  test('finishes after a non-empty page completes', () => {
    const pending = getInitialNavigationPending(true, 'https://site1.com/page', 'complete')

    expect(pending).toBe(false)
  })
})

describe('reopenTab', () => {
  beforeEach(() => {
    browser.tabs.create = vi.fn().mockResolvedValue({})
    browser.tabs.reload = vi.fn().mockResolvedValue(undefined)
    browser.tabs.remove = vi.fn().mockResolvedValue(undefined)
  })

  test('preserves a loaded source tab when opening a container redirect', async () => {
    await reopenTab(tab(), 'https://site2.com/page', 'firefox-container-2', {
      preserveSource: true,
    })

    expect(browser.tabs.create).toHaveBeenCalledWith({
      windowId: 1,
      url: 'https://site2.com/page',
      cookieStoreId: 'firefox-container-2',
      active: true,
      index: 4,
      pinned: false,
      openerTabId: 1,
    })
    expect(browser.tabs.reload).toHaveBeenCalledWith(1)
    expect(browser.tabs.remove).not.toHaveBeenCalled()
  })
})
