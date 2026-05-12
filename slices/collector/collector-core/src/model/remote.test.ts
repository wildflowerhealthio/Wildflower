// oxlint-disable typescript-eslint/no-unsafe-assignment -- vitest matchers (`expect.stringContaining`, …) are typed as `any`; composing them inside `objectContaining` is the intended idiom

import { describe, expect, it } from 'vite-plus/test'

import { SimpleEntity } from '../test-helpers.ts'
import * as Remote from './remote.ts'

/**
 * `Remote.make` is a pure data constructor — the only thing it does is
 * normalize the config into a `Remote` value. The dispatch state machine
 * lives in `CollectorBridgeMessageHandler`; tests for the runtime behavior
 * are in `collector-bridge-message-handler.test.ts`.
 */
describe('Remote.make', () => {
  it('returns the config it was given, field-for-field', () => {
    const remote = Remote.make<{ name: string; age: number }>({
      name: 'TestRemote',
      firstPage: { uri: 'https://example.com/people' },
      entityDefinitions: [SimpleEntity],
    })

    expect(remote).toEqual({
      name: 'TestRemote',
      firstPage: { uri: 'https://example.com/people' },
      entityDefinitions: [SimpleEntity],
    })
  })

  it('supports both Uri and Html firstPage variants', () => {
    expect(
      Remote.make<{ name: string; age: number }>({
        name: 'InlineRemote',
        firstPage: { html: '<!DOCTYPE html><html><body>boot</body></html>' },
        entityDefinitions: [SimpleEntity],
      })
    ).toMatchObject({
      firstPage: { html: expect.stringContaining('boot') },
    })
  })
})
