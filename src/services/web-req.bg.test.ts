import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { BgTab } from 'src/types'
import * as Settings from 'src/services/settings'

vi.mock('src/services/tabs.bg', () => ({
  byId: {} as Record<ID, BgTab>,
  reopenTab: vi.fn(),
  showProxyBadge: vi.fn(),
  hideProxyBadge: vi.fn(),
  isEmptyTabUrl: (url: string) =>
    url === '' || url.startsWith('about:blank') || url.startsWith('about:newtab'),
}))

import {
  containersProxies,
  getContainerRequestAction,
  getContainerRequestRoute,
  proxyReqHandler,
} from 'src/services/web-req.bg'

function tab(overrides: Partial<BgTab> = {}): BgTab {
  return {
    id: 2,
    windowId: 1,
    index: 1,
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
    ...overrides,
  }
}

describe('container request routing', () => {
  beforeEach(() => {
    Settings.state.containerReopenPreserveSource = false
  })
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
    const route = getContainerRequestRoute(source, urls[target], includeRules, {})

    if (expectedContainer === undefined) expect(route).toBeUndefined()
    else if (expectedContainer === defaultContainer) expect(route).toEqual({ type: 'default' })
    else expect(route).toEqual({ type: 'container', containerId: expectedContainer })
  })

  test('routes an unmatched URL out of a container with include rules', () => {
    const route = getContainerRequestRoute(containerA, urls[defaultContainer], includeRules, {})

    expect(route).toEqual({ type: 'default' })
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

  test('replaces a new source tab when rerouting its initial request', () => {
    const action = getContainerRequestAction(
      { cookieStoreId: containerA, method: 'GET', url: urls[containerB] },
      tab({ cookieStoreId: containerA, initialNavigationPending: true }),
      includeRules,
      {}
    )

    expect(action).toEqual({
      type: 'reroute',
      targetContainerId: containerB,
      preserveSource: false,
    })
  })

  test.each(['', 'about:blank', 'about:newtab'])(
    'replaces an empty source tab with URL %j',
    sourceUrl => {
      Settings.state.containerReopenPreserveSource = true
      const action = getContainerRequestAction(
        { cookieStoreId: defaultContainer, method: 'GET', url: urls[containerA] },
        tab({
          cookieStoreId: defaultContainer,
          initialNavigationPending: false,
          url: sourceUrl,
        }),
        includeRules,
        {}
      )

      expect(action).toEqual({
        type: 'reroute',
        targetContainerId: containerA,
        preserveSource: false,
      })
    }
  )

  test('replaces a loaded source tab by default', () => {
    const action = getContainerRequestAction(
      { cookieStoreId: containerA, method: 'GET', url: urls[containerB] },
      tab({ cookieStoreId: containerA, initialNavigationPending: false }),
      includeRules,
      {}
    )

    expect(action).toEqual({
      type: 'reroute',
      targetContainerId: containerB,
      preserveSource: false,
    })
  })

  test('preserves a loaded source tab when configured', () => {
    Settings.state.containerReopenPreserveSource = true
    const action = getContainerRequestAction(
      { cookieStoreId: containerA, method: 'GET', url: urls[containerB] },
      tab({ cookieStoreId: containerA, initialNavigationPending: false }),
      includeRules,
      {}
    )

    expect(action).toEqual({
      type: 'reroute',
      targetContainerId: containerB,
      preserveSource: true,
    })
  })

  test('allows unsafe methods instead of recreating them as GET requests', () => {
    const action = getContainerRequestAction(
      { cookieStoreId: containerA, method: 'POST', url: urls[containerB] },
      tab({ cookieStoreId: containerA }),
      includeRules,
      {}
    )

    expect(action).toEqual({ type: 'allow' })
  })

  test('selects the proxy configured for the routed container', () => {
    const proxy: browser.proxy.ProxyInfo = { host: 'proxy.example', port: '8080', type: 'http' }
    containersProxies[containerA] = proxy

    const result = proxyReqHandler({
      cookieStoreId: containerA,
      documentUrl: '',
      frameId: 0,
      fromCache: false,
      incognito: false,
      method: 'GET',
      originUrl: '',
      parentFrameId: -1,
      requestId: 'proxy-request',
      tabId: 2,
      thirdParty: false,
      timeStamp: 0,
      type: 'main_frame',
      url: urls[containerA],
    })
    delete containersProxies[containerA]

    expect(result).toBe(proxy)
  })
})
