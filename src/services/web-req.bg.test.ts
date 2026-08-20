import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { BgTab } from 'src/types'
import * as Settings from 'src/services/settings'

const tabs = vi.hoisted(() => ({
  byId: {} as Record<ID, BgTab>,
  reopenTab: vi.fn(),
  showProxyBadge: vi.fn(),
  hideProxyBadge: vi.fn(),
  isEmptyTabUrl: (url: string) =>
    url === '' || url.startsWith('about:blank') || url.startsWith('about:newtab'),
}))

vi.mock('src/services/tabs.bg', () => tabs)

import {
  containerRequestHandler,
  containersProxies,
  disableAutoReopening,
  enableAutoReopening,
  getContainerRequestAction,
  getContainerRequestRoute,
  proxyReqHandler,
  resolveRequestTab,
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

function request(
  overrides: Partial<browser.webRequest.ReqDetails> = {}
): browser.webRequest.ReqDetails {
  return {
    cookieStoreId: 'firefox-default',
    documentUrl: '',
    frameId: 0,
    incognito: false,
    method: 'GET',
    originUrl: '',
    parentFrameId: -1,
    proxyInfo: { type: 'direct' },
    requestId: 'request-1',
    tabId: 2,
    thirdParty: false,
    timeStamp: 0,
    type: 'main_frame',
    url: 'https://example.com/page',
    ...overrides,
  }
}

function setTabCreatedEvent(event: typeof browser.tabs.onCreated): void {
  Object.defineProperty(browser.tabs, 'onCreated', { configurable: true, value: event })
}

function setTabRemovedEvent(event: typeof browser.tabs.onRemoved): void {
  Object.defineProperty(browser.tabs, 'onRemoved', { configurable: true, value: event })
}

describe('container request routing', () => {
  beforeEach(() => {
    tabs.byId = {}
    Settings.state.containerReopenPreserveSource = false
    tabs.reopenTab.mockReset().mockResolvedValue(true)
    vi.restoreAllMocks()
    setTabCreatedEvent({
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(),
    })
    setTabRemovedEvent({
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(),
    })
  })

  test('resolves a newly opened tab before the created event is processed', async () => {
    const nativeTab = tab({ url: 'about:blank', openerTabId: 1 })
    const get = vi.fn().mockResolvedValue(nativeTab)
    browser.tabs.get = get

    const result = await resolveRequestTab(nativeTab.id)

    expect(result).toEqual({ ...nativeTab, initialNavigationPending: true })
    expect(get).toHaveBeenCalledWith(nativeTab.id)
  })

  test('waits for a newly opened tab when it is not immediately available', async () => {
    const nativeTab = tab({ url: 'about:blank', openerTabId: 1 })
    let onCreated: ((createdTab: browser.tabs.Tab) => void) | undefined
    setTabCreatedEvent({
      addListener: (listener: (createdTab: browser.tabs.Tab) => void) => (onCreated = listener),
      removeListener: vi.fn(),
      hasListener: vi.fn(),
    })
    browser.tabs.get = vi.fn().mockRejectedValue(new Error('Invalid tab ID'))

    const resultPromise = resolveRequestTab(nativeTab.id)
    onCreated?.(nativeTab)
    const result = await resultPromise

    expect(result).toEqual({ ...nativeTab, initialNavigationPending: true })
  })

  test('stops waiting when the requested tab is removed', async () => {
    let onRemoved: Parameters<typeof browser.tabs.onRemoved.addListener>[0] | undefined
    setTabRemovedEvent({
      addListener: listener => (onRemoved = listener),
      removeListener: vi.fn(),
      hasListener: vi.fn(),
    })
    browser.tabs.get = vi.fn().mockRejectedValue(new Error('Invalid tab ID'))

    const resultPromise = resolveRequestTab(2)
    onRemoved?.(2, { isWindowClosing: false, windowId: 1 })
    const result = await resultPromise

    expect(result).toBeUndefined()
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

  test('cancels a mismatched request after creating its replacement', async () => {
    const sourceTab = tab({
      cookieStoreId: defaultContainer,
      initialNavigationPending: true,
      reopenInContainer: containerA,
    })
    tabs.byId[sourceTab.id] = sourceTab

    const response = await containerRequestHandler(
      request({ cookieStoreId: defaultContainer, url: urls[defaultContainer] })
    )

    expect(tabs.reopenTab).toHaveBeenCalledWith(sourceTab, urls[defaultContainer], containerA, {
      preserveSource: false,
    })
    expect(response).toEqual({ cancel: true })
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

  test('uses the panel container for an unmatched new-tab request', () => {
    const action = getContainerRequestAction(
      { cookieStoreId: defaultContainer, method: 'GET', url: urls[defaultContainer] },
      tab({
        cookieStoreId: defaultContainer,
        initialNavigationPending: true,
        reopenInContainer: containerA,
      }),
      includeRules,
      {}
    )

    expect(action).toEqual({
      type: 'reroute',
      targetContainerId: containerA,
      preserveSource: false,
    })
  })

  test('does not reroute private requests', async () => {
    const response = await containerRequestHandler(request({ incognito: true }))

    expect(response).toBeUndefined()
    expect(tabs.reopenTab).not.toHaveBeenCalled()
  })

  test('honors a temporary manual-routing override', async () => {
    const sourceTab = tab({
      cookieStoreId: containerB,
      initialNavigationPending: true,
      reopenInContainer: containerA,
    })
    tabs.byId[sourceTab.id] = sourceTab
    disableAutoReopening(containerB, 1000)

    const response = await containerRequestHandler(
      request({ cookieStoreId: containerB, requestId: 'manual-override' })
    )
    enableAutoReopening([])

    expect(response).toBeUndefined()
    expect(tabs.reopenTab).not.toHaveBeenCalled()
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

  test('allows unsafe methods instead of recreating them as GET requests', () => {
    const action = getContainerRequestAction(
      { cookieStoreId: containerA, method: 'POST', url: urls[containerB] },
      tab({ cookieStoreId: containerA }),
      includeRules,
      {}
    )

    expect(action).toEqual({ type: 'allow' })
  })
})
