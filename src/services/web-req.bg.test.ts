import { describe, expect, test, vi } from 'vitest'
import type { BgTab } from 'src/types'

vi.mock('src/services/tabs.bg', () => ({
  byId: {} as Record<ID, BgTab>,
  reopenTab: vi.fn(),
  showProxyBadge: vi.fn(),
  hideProxyBadge: vi.fn(),
}))

import { getContainerRequestRoute } from 'src/services/web-req.bg'

describe('container request routing', () => {
  const defaultContainer = 'firefox-default'
  const containerA = 'firefox-container-a'
  const containerB = 'firefox-container-b'
  const urls: Record<string, string> = {
    [defaultContainer]: 'https://example.com/page',
    [containerA]: 'https://site1.com/page',
    [containerB]: 'https://site2.com/page',
  }
  const includeRules = [
    { ctx: containerA, value: /^https:\/\/site1\.com(?:\/|$)/ },
    { ctx: containerB, value: /^https:\/\/site2\.com(?:\/|$)/ },
  ]
  const excludeRules = {
    [containerA]: [/^https:\/\/example\.com(?:\/|$)/],
    [containerB]: [/^https:\/\/example\.com(?:\/|$)/],
  }

  test.each([
    [defaultContainer, defaultContainer, undefined],
    [defaultContainer, containerA, containerA],
    [defaultContainer, containerB, containerB],
    [containerA, defaultContainer, defaultContainer],
    [containerA, containerA, undefined],
    [containerA, containerB, containerB],
    [containerB, defaultContainer, defaultContainer],
    [containerB, containerA, containerA],
    [containerB, containerB, undefined],
  ])('routes %s to %s through %s', (source, target, expectedContainer) => {
    const route = getContainerRequestRoute(source, urls[target], includeRules, excludeRules)

    if (expectedContainer === undefined) expect(route).toBeUndefined()
    else if (expectedContainer === defaultContainer) expect(route).toEqual({ type: 'default' })
    else expect(route).toEqual({ type: 'container', containerId: expectedContainer })
  })

  test('leaves an unmatched URL in its source container without an exclude rule', () => {
    const route = getContainerRequestRoute(containerA, urls[defaultContainer], includeRules, {})

    expect(route).toBeUndefined()
  })

  test('keeps a matching source when include rules overlap', () => {
    const overlappingRules = [
      { ctx: containerA, value: 'shared.example' },
      { ctx: containerB, value: 'shared.example' },
    ]
    const url = 'https://shared.example/page'

    expect(getContainerRequestRoute(containerA, url, overlappingRules, {})).toBeUndefined()
    expect(getContainerRequestRoute(containerB, url, overlappingRules, {})).toBeUndefined()
    expect(getContainerRequestRoute(defaultContainer, url, overlappingRules, {})).toEqual({
      type: 'container',
      containerId: containerA,
    })
  })
})
