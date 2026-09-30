import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as DataElement from './data-element.ts'

const tagArbitrary = fc.integer({ min: 0, max: 0xffff_ffff })

const elementOf = (tag: number): DataElement.Type => ({
  tag,
  vr: 'LO',
  value: new Uint8Array(),
  undefinedLength: false,
})

describe('DataElement', () => {
  it('labels a tag as the standard writes it', () => {
    expect(DataElement.tagLabelOf(0x0010_0010)).toBe('(0010,0010)')
    expect(DataElement.tagLabelOf(0x7fe0_0010)).toBe('(7FE0,0010)')
  })

  it('property: an element is private exactly when its group is odd', () => {
    fc.assert(
      fc.property(tagArbitrary, (tag) => {
        const group = Number.parseInt(DataElement.tagLabelOf(tag).slice(1, 5), 16)
        expect(DataElement.isPrivate(elementOf(tag))).toBe(group % 2 === 1)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('property: byTag orders by group, then element', () => {
    fc.assert(
      fc.property(fc.array(tagArbitrary), (tags) => {
        const labels = tags
          .map(elementOf)
          .toSorted(DataElement.byTag)
          .map((element) => DataElement.tagLabelOf(element.tag))
        expect(labels).toEqual(labels.toSorted())
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
