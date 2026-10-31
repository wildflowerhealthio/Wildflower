import * as fc from 'fast-check'

import { text } from '../document/printed-text.ts'
import { arbitrary as groupArbitrary } from './group-arbitrary.ts'
import type * as Section from './section.ts'

/**
 * The fast-check arbitrary for a {@link Section.Type}: its leading group (if
 * any) is the unnamed one, the rest are named. Test-only.
 *
 * @packageDocumentation
 */
const arbitrary = (licence: fc.Arbitrary<string>): fc.Arbitrary<Section.Type> =>
  fc
    .record({
      name: text(30),
      comments: fc.array(text(48), { maxLength: 2 }),
      leading: fc.option(groupArbitrary(licence, true), { nil: undefined }),
      named: fc.array(groupArbitrary(licence, false), { maxLength: 2 }),
    })
    .map(({ name, comments, leading, named }) => ({
      name,
      comments,
      groups: leading === undefined ? named : [leading, ...named],
    }))

export { arbitrary }
