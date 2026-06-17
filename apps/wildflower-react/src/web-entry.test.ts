import { TOKEN_STORAGE_KEY } from 'gatekeeper-react'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import { stubTransport } from './bridges/transport-context.ts'
import { makeWebEntryOptions } from './web-entry.ts'

describe('makeWebEntryOptions', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  test('makeTransport resolves to the shared stub transport', async () => {
    const { makeTransport } = makeWebEntryOptions()
    const transport = await makeTransport(
      () => {},
      () => {},
      () => {}
    )
    expect(transport).toBe(stubTransport)
  })

  test('tokenStore is localStorage-backed (writes persist)', () => {
    const { tokenStore } = makeWebEntryOptions()
    tokenStore.setToken('persist-me')
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('persist-me')
  })

  test('awaitAuthReady resolves once the returned store holds a token', async () => {
    const { tokenStore, awaitAuthReady } = makeWebEntryOptions()
    tokenStore.setToken('a-bearer')
    // `awaitAuthReady` reads the *same* store's subscribable, so a
    // present token resolves the readiness gate without redirecting.
    await expect(awaitAuthReady(Promise.resolve())()).resolves.toBeUndefined()
  })

  test('awaitAuthReady rejects (device-login redirect) when the store is empty', async () => {
    const { awaitAuthReady } = makeWebEntryOptions()
    await expect(awaitAuthReady(Promise.resolve())()).rejects.toBeDefined()
  })

  test('each call builds an independent store', () => {
    const first = makeWebEntryOptions()
    const second = makeWebEntryOptions()
    expect(first.tokenStore).not.toBe(second.tokenStore)
  })
})
