import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { makeCollectorHttpResponse } from '../test-helpers.ts'
import * as CollectorHttpResponseKind from './collector-http-response-kind.ts'

interface Person {
  readonly name: string
}

const followUpSteps = (): readonly never[] => []

const definition: CollectorHttpResponseKind.CollectorHttpResponseKind<Person> = {
  name: 'PersonEntity',
  isFoundAt: (url) => url.includes('/people/'),
  parse: () => Effect.succeed([{ name: 'Alice' }]),
  followUpSteps,
}

describe('CollectorHttpResponseKind.make', () => {
  it('copies followUpSteps through by reference and keeps it callable', () => {
    const made = CollectorHttpResponseKind.make(definition)

    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; asserting the copied reference
    expect(made.followUpSteps).toBe(followUpSteps)
    expect(made.followUpSteps?.([{ name: 'Alice' }], makeCollectorHttpResponse())).toEqual([])
  })

  it('freezes the definition so a caller cannot re-route it after construction', () => {
    const made = CollectorHttpResponseKind.make(definition)

    expect(Object.isFrozen(made)).toBe(true)
    expect(() => {
      made.followUpSteps = () => []
    }).toThrow()
  })

  it('leaves followUpSteps undefined for a leaf entity', () => {
    const made = CollectorHttpResponseKind.make({
      name: 'LeafEntity',
      isFoundAt: () => true,
      parse: () => Effect.succeed([]),
    })

    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; asserting absence
    expect(made.followUpSteps).toBeUndefined()
  })
})
