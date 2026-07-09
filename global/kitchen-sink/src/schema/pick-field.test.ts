import { Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import { pickField } from './pick-field.ts'

describe('pickField', () => {
  const Person = Schema.Struct({
    name: Schema.String,
    age: Schema.NumberFromString,
  })

  describe('types', () => {
    it('narrows the decoded type to the picked field', () => {
      const NameOnly = pickField(Person, 'name')
      expectTypeOf<typeof NameOnly.Type>().toEqualTypeOf<{ readonly name: string }>()
    })

    it('narrows the encoded type to the picked field', () => {
      const AgeOnly = pickField(Person, 'age')
      expectTypeOf<typeof AgeOnly.Encoded>().toEqualTypeOf<{ readonly age: string }>()
    })
  })

  it('drops the unpicked fields when decoding', () => {
    const NameOnly = pickField(Person, 'name')
    const result = Schema.decodeUnknownSync(NameOnly)({ name: 'Ada', age: '36' })
    expect(result).toStrictEqual({ name: 'Ada' })
  })

  it('round-trips the picked field through its inner schema', () => {
    const AgeOnly = pickField(Person, 'age')
    const decoded = Schema.decodeUnknownSync(AgeOnly)({ age: '36' })
    expect(decoded).toStrictEqual({ age: 36 })
    expect(Schema.encodeSync(AgeOnly)(decoded)).toStrictEqual({ age: '36' })
  })
})
