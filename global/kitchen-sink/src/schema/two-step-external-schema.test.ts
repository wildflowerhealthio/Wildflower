import { Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { ThreeStepExternalSchema, TwoStepExternalSchema } from './two-step-external-schema.ts'

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

// --- Three-step test schemas ---

// An "integration" type — the decoded form of the raw integration payload
const IntegrationPerson = Schema.Struct({
  birthYear: Schema.Int,
  familyName: Schema.String,
  givenName: Schema.String,
})

// The raw integration-encoded payload (e.g. wire format)
const IntegrationPersonEncoded = Schema.Struct({
  birth_year: Schema.Int,
  family_name: Schema.String,
  given_name: Schema.String,
})

// Step 1: IntegrationEncoded → IntegrationType
const IntegrationFromEncoded = Schema.transform(IntegrationPersonEncoded, IntegrationPerson, {
  decode: (raw) => ({
    givenName: raw.given_name,
    familyName: raw.family_name,
    birthYear: raw.birth_year,
  }),
  encode: (decoded) => ({
    given_name: decoded.givenName,
    family_name: decoded.familyName,
    birth_year: decoded.birthYear,
  }),
  strict: true,
})

// Step 2: IntegrationType → DomainEncoded
const DomainEncodedFromIntegration = Schema.transform(IntegrationPerson, DomainPersonEncoded, {
  decode: (integration) => ({
    fullName: `${integration.givenName} ${integration.familyName}`,
    age: new Date().getFullYear() - integration.birthYear,
  }),
  encode: (encoded) => ({
    givenName: encoded.fullName.split(' ')[0] ?? '',
    familyName: encoded.fullName.split(' ').slice(1).join(' '),
    birthYear: new Date().getFullYear() - encoded.age,
  }),
  strict: true,
})

// Step 3: DomainEncoded → Domain (reuses EncodedToDomain from above)

describe('ThreeStepExternalSchema', () => {
  const threeStep = new ThreeStepExternalSchema(
    EncodedToDomain,
    IntegrationFromEncoded,
    DomainEncodedFromIntegration
  )

  it('decodes from integration-encoded to domain type', () => {
    const decoded = Schema.decodeUnknownSync(threeStep)({
      birth_year: 1996,
      family_name: 'Smith',
      given_name: 'Alice',
    })

    expect(decoded).toBeInstanceOf(DomainPerson)
    expect(decoded.fullName).toBe('Alice Smith')
    expect(decoded.age).toBe(new Date().getFullYear() - 1996)
  })

  it('encodes from domain to integration-encoded type', () => {
    const age = 30
    const encoded = Schema.encodeSync(threeStep)(new DomainPerson({ age, fullName: 'Bob Jones' }))

    expect(encoded).toEqual({
      birth_year: new Date().getFullYear() - age,
      family_name: 'Jones',
      given_name: 'Bob',
    })
  })

  it('round-trips decode then encode', () => {
    const input = {
      birth_year: 2000,
      family_name: 'Brown',
      given_name: 'Charlie',
    }

    const decoded = Schema.decodeUnknownSync(threeStep)(input)
    const encoded = Schema.encodeSync(threeStep)(decoded)

    expect(encoded).toEqual(input)
  })

  it('exposes DomainEncodedFromExternalType schema', () => {
    const decoded = Schema.decodeUnknownSync(threeStep.DomainEncodedFromExternalType)({
      birthYear: 1990,
      familyName: 'White',
      givenName: 'Dave',
    })

    expect(decoded).toEqual({
      age: new Date().getFullYear() - 1990,
      fullName: 'Dave White',
    })
  })

  it('has a valid ast property', () => {
    expect(threeStep.ast).toBeDefined()
  })

  it('supports annotations', () => {
    const annotated = threeStep.annotations({ identifier: 'TestThreeStep' })
    expect(annotated).toBeDefined()
    const decoded = Schema.decodeUnknownSync(annotated)({
      birth_year: 1985,
      family_name: 'Green',
      given_name: 'Eve',
    })
    expect(decoded).toBeInstanceOf(DomainPerson)
  })

  it('is assignable to Schema.Schema', () => {
    const schema: Schema.Schema<DomainPerson, typeof IntegrationPersonEncoded.Type> = threeStep
    expect(schema).toBe(threeStep)
  })
})
