import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
}))

import { registerIpc } from '../../electron/main/ipc'

function serviceStub(): Record<string, unknown> {
  return new Proxy({}, { get: () => vi.fn(async () => undefined) })
}

describe('session change IPC', () => {
  it('broadcasts only to still-trusted authorized renderers and unsubscribes on disposal', () => {
    let notify: ((event: { filePath?: string }) => void) | undefined
    const unsubscribe = vi.fn()
    const sessions = {
      ...serviceStub(),
      onDidChange: vi.fn((listener: (event: { filePath?: string }) => void) => {
        notify = listener
        return unsubscribe
      }),
    }
    const services = {
      meta: {},
      projects: serviceStub(),
      sessions,
      agents: serviceStub(),
      terminals: serviceStub(),
      git: serviceStub(),
      plugins: serviceStub(),
      settings: serviceStub(),
      schedules: serviceStub(),
    }
    const expectedUrl = 'prime-work://app/'
    const trusted = {
      id: 1,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
      send: vi.fn(),
    }
    let navigatedUrl = expectedUrl
    const navigated = {
      id: 2,
      getURL: () => navigatedUrl,
      mainFrame: { get url() { return navigatedUrl } },
      isDestroyed: () => false,
      send: vi.fn(),
    }
    const unauthorized = {
      id: 3,
      getURL: () => expectedUrl,
      mainFrame: { url: expectedUrl },
      isDestroyed: () => false,
      send: vi.fn(),
    }

    const registration = registerIpc(services as never, expectedUrl)
    registration.authorize(trusted as never)
    registration.authorize(navigated as never)
    navigatedUrl = 'https://example.com/'
    notify?.({ filePath: '/tmp/session.jsonl' })

    expect(trusted.send).toHaveBeenCalledWith('sessions:changed', { filePath: '/tmp/session.jsonl' })
    expect(navigated.send).not.toHaveBeenCalled()
    expect(unauthorized.send).not.toHaveBeenCalled()

    registration.revoke(trusted.id)
    notify?.({})
    expect(trusted.send).toHaveBeenCalledTimes(1)

    registration.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    notify?.({ filePath: '/tmp/later.jsonl' })
    expect(trusted.send).toHaveBeenCalledTimes(1)
  })
})
