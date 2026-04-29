import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { TwoStepExternalSchema } from './two-step-external-schema.ts'

// --- Test schemas ---

// A simple "domain" type
class DomainPerson extends Schema.Class<DomainPerson>('DomainPerson')({
  age: Schema.Int,
  fullName: Schema.String,
}) {}

// An "encoded" intermediate representation (domain-encoded)
const DomainPersonEncoded = Schema.Struct({
  age: Schema.Int,
  fullName: Schema.String,
})

// The "external" representation (e.g., FHIR JSON)
const ExternalPersonEncoded = Schema.Struct({
  name: Schema.String,
  yearsOld: Schema.Int,
})

// Transform: External → DomainEncoded
const ExternalToEncoded = Schema.transform(ExternalPersonEncoded, DomainPersonEncoded, {
  decode: (external) => ({
    fullName: external.name,
    age: external.yearsOld,
  }),
  encode: (encoded) => ({
    name: encoded.fullName,
    yearsOld: encoded.age,
  }),
  strict: true,
})

// Transform: DomainEncoded → Domain
const EncodedToDomain = Schema.transform(DomainPersonEncoded, DomainPerson, {
  decode: (encoded) => new DomainPerson(encoded),
  encode: (domain) => ({
    fullName: domain.fullName,
    age: domain.age,
  }),
  strict: true,
})

describe('TwoStepExternalSchema', () => {
  const twoStep = new TwoStepExternalSchema(EncodedToDomain, ExternalToEncoded)

  it('decodes from external to domain type', () => {
    const decoded = Schema.decodeUnknownSync(twoStep)({
      name: 'Alice',
      yearsOld: 30,
    })

    expect(decoded).toBeInstanceOf(DomainPerson)
    expect(decoded.fullName).toBe('Alice')
    expect(decoded.age).toBe(30)
  })

  it('encodes from domain to external type', () => {
    const encoded = Schema.encodeSync(twoStep)(new DomainPerson({ age: 25, fullName: 'Bob' }))

    expect(encoded).toEqual({ name: 'Bob', yearsOld: 25 })
  })

  it('exposes EncodedFromExternal schema', () => {
    const decoded = Schema.decodeUnknownSync(twoStep.EncodedFromExternal)({
      name: 'Charlie',
      yearsOld: 40,
    })

    expect(decoded).toEqual({ age: 40, fullName: 'Charlie' })
  })

  it('has a valid ast property', () => {
    expect(twoStep.ast).toBeDefined()
  })

  it('supports annotations', () => {
    const annotated = twoStep.annotations({ identifier: 'TestPerson' })
    expect(annotated).toBeDefined()
    // Should still decode correctly
    const decoded = Schema.decodeUnknownSync(annotated)({
      name: 'Dave',
      yearsOld: 35,
    })
    expect(decoded).toBeInstanceOf(DomainPerson)
  })

  it('is assignable to Schema.Schema', () => {
    // Type-level test: this should compile
    const schema: Schema.Schema<DomainPerson, typeof ExternalPersonEncoded.Type> = twoStep
    expect(schema).toBe(twoStep)
  })
})
