import { Effect } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { makeRemoteResponse } from '../test-helpers.ts'
import * as CollectorEntityDefinition from './collector-entity-definition.ts'

interface Person {
  readonly name: string
}

const followUpSteps = (): readonly never[] => []

const definition: CollectorEntityDefinition.CollectorEntityDefinition<Person> = {
  name: 'PersonEntity',
  isFoundAt: (url) => url.includes('/people/'),
  parse: () => Effect.succeed([{ name: 'Alice' }]),
  followUpSteps,
}

describe('CollectorEntityDefinition.make', () => {
  it('copies followUpSteps through by reference and keeps it callable', () => {
    const made = CollectorEntityDefinition.make(definition)

    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; asserting the copied reference
    expect(made.followUpSteps).toBe(followUpSteps)
    expect(made.followUpSteps?.([{ name: 'Alice' }], makeRemoteResponse())).toEqual([])
  })

  it('freezes the definition so a caller cannot re-route it after construction', () => {
    const made = CollectorEntityDefinition.make(definition)

    expect(Object.isFrozen(made)).toBe(true)
    expect(() => {
      made.followUpSteps = () => []
    }).toThrow()
  })

  it('leaves followUpSteps undefined for a leaf entity', () => {
    const made = CollectorEntityDefinition.make({
      name: 'LeafEntity',
      isFoundAt: () => true,
      parse: () => Effect.succeed([]),
    })

    // oxlint-disable-next-line typescript-eslint/unbound-method -- pure, this-free method; asserting absence
    expect(made.followUpSteps).toBeUndefined()
  })
})
