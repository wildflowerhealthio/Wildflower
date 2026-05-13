import { describe, expect, it } from 'vite-plus/test'

import { SimpleEntity } from '../test-helpers.ts'
import * as RemoteKind from './remote-kind.ts'

/**
 * `RemoteKind.make` is a pure data constructor — the only thing it
 * does is normalize the config into a `RemoteKind` value. The dispatch
 * state machine lives in `CollectorBridgeMessageHandler`; tests for
 * the runtime behavior are in `collector-bridge-message-handler.test.ts`.
 */
describe('RemoteKind.make', () => {
  it('returns the config it was given, field-for-field', () => {
    const remote = RemoteKind.make<{ name: string; age: number }>({
      name: 'TestRemote',
      entityDefinitions: [SimpleEntity],
    })

    expect(remote).toEqual({
      name: 'TestRemote',
      entityDefinitions: [SimpleEntity],
    })
  })

  it('deep-freezes the returned value so callers cannot mutate it after construction', () => {
    const remote = RemoteKind.make<{ name: string; age: number }>({
      name: 'FrozenRemote',
      entityDefinitions: [SimpleEntity],
    })

    expect(Object.isFrozen(remote)).toBe(true)
    expect(Object.isFrozen(remote.entityDefinitions)).toBe(true)
  })
})
