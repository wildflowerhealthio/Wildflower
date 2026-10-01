import { Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { issueMessagesOf, issuePathsOf } from '../test-helpers.ts'
import { checkArrayHasOneMatchingElement } from './check-array-has-one-matching-element.ts'
import {
  type ArrayElementsCheck,
  filterArrayWithEveryCheck,
} from './filter-array-with-every-check.ts'

const RUNS = numRunsFor({ base: 100 })

/** A tagged amount: what the arrays under test hold. */
const TaggedAmountSchema = Schema.Struct({ tag: Schema.String, amount: Schema.Number })

type TaggedAmount = typeof TaggedAmountSchema.Type

/** Checks tagged amounts hold exactly one tagged `tag`, its amount positive. */
const checkArrayHasOnePositive = (tag: string): ArrayElementsCheck<TaggedAmount> =>
  checkArrayHasOneMatchingElement({
    matches: (taggedAmount: TaggedAmount) => taggedAmount.tag === tag,
    schema: Schema.Struct({ amount: Schema.Number.pipe(Schema.positive()) }),
    expected: `"${tag}" amount`,
  })

/** Tagged amounts that must hold one positive `a` and one positive `b`. */
const OnePositiveEachSchema = Schema.Array(TaggedAmountSchema).pipe(
  filterArrayWithEveryCheck([checkArrayHasOnePositive('a'), checkArrayHasOnePositive('b')])
)

const decode = Schema.decodeEither(OnePositiveEachSchema, { errors: 'all' })

/** Tagged amounts tagged with anything but `a` and `b`. */
const othersArb = fc.array(
  fc.record({
    tag: fc.string().filter((tag) => tag !== 'a' && tag !== 'b'),
    amount: fc.double({ noNaN: true }),
  }),
  { maxLength: 3 }
)

describe('filterArrayWithEveryCheck over checkArrayHasOneMatchingElement', () => {
  it('should accept exactly one well-formed match of each, among anything else', () => {
    fc.assert(
      fc.property(othersArb, fc.boolean(), (others, bFirst) => {
        const a = { tag: 'a', amount: 1 }
        const b = { tag: 'b', amount: 2 }
        expect(issuePathsOf(decode([...others, ...(bFirst ? [b, a] : [a, b])]))).toEqual([])
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse no match or several at the array, counting them', () => {
    fc.assert(
      fc.property(othersArb, fc.constantFrom(0, 2, 3), (others, count) => {
        const as = Array.from({ length: count }, () => ({ tag: 'a', amount: 1 }))
        const result = decode([...others, ...as, { tag: 'b', amount: 1 }])
        expect(issuePathsOf(result)).toEqual([''])
        expect(issueMessagesOf(result)).toEqual([`expected exactly one "a" amount, found ${count}`])
      }),
      { numRuns: RUNS }
    )
  })

  it("should name a malformed match's own issue at its index", () => {
    fc.assert(
      fc.property(othersArb, (others) => {
        const result = decode([...others, { tag: 'a', amount: -1 }, { tag: 'b', amount: 1 }])
        expect(issuePathsOf(result)).toEqual([`${others.length}.amount`])
      }),
      { numRuns: RUNS }
    )
  })

  it('should name every check that fails, not only the first', () => {
    fc.assert(
      fc.property(othersArb, (others) => {
        const result = decode([...others, { tag: 'b', amount: 0 }])
        expect(issuePathsOf(result)).toEqual(['', `${others.length}.amount`])
      }),
      { numRuns: RUNS }
    )
  })
})
