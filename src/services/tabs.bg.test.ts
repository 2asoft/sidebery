import { describe, expect, test } from 'vitest'
import { getInitialNavigationPending } from 'src/services/tabs.bg'

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
