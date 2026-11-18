import { Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { patient } from './identity-map.test-helpers.ts'
import * as LinkChoice from './link-choice.ts'

const STORED = patient({ id: 's-1', system: 'https://device.example/id' })

describe('LinkChoice.storedResourceOf', () => {
  it('should give the stored resource a link points at', () => {
    expect(
      LinkChoice.storedResourceOf(LinkChoice.LinkToStoredResource({ resource: STORED }))
    ).toEqual(Option.some(STORED))
  })

  it('should give the stored resource an update writes over', () => {
    expect(
      LinkChoice.storedResourceOf(LinkChoice.UpdateStoredResource({ resource: STORED }))
    ).toEqual(Option.some(STORED))
  })

  it('should give none for a choice that creates the resource', () => {
    expect(LinkChoice.storedResourceOf(LinkChoice.CreateResource())).toEqual(Option.none())
  })
})
