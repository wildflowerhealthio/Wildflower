import type { EntityDefinition } from 'collector-fundamentals/model'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, Duration, Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  InstanceConfig,
  SHOPPERS_DRUGMART_SYSTEM,
  ShoppersDrugMartCollectorDescriptor,
  defaultConfig,
  scrapingPlan,
} from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

describe('InstanceConfig', () => {
  it('decodes defaultConfig without error', () => {
    expectRightToEqual(Schema.decodeUnknownEither(InstanceConfig)(defaultConfig), defaultConfig)
  })

  it('round-trips any schema-conformant email and password', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const encoded = Schema.encodeSync(InstanceConfig)(config)
        expect(Schema.decodeSync(InstanceConfig)(encoded)).toEqual(config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects missing email', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'shoppers-drugmart', password: 'pw' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects missing password', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'shoppers-drugmart', email: 'a@b.com' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each([
    '',
    'not-an-email',
    '@example.com',
    'a@b',
    'no-domain@',
    'has space@example.com',
    'a@ex ample.com',
  ])('rejects malformed email %j', (email) => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({
        _tag: 'shoppers-drugmart',
        email,
        password: 'pw',
      }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each([['' /* empty */], ['x'.repeat(257) /* over-long */]])(
    'rejects malformed password (len %s)',
    (password) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({
          _tag: 'shoppers-drugmart',
          email: 'a@b.com',
          password,
        }),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  )
})

describe('defaultConfig', () => {
  it('is a harmless, valid placeholder', () => {
    expect(defaultConfig).toEqual({
      _tag: 'shoppers-drugmart',
      email: 'you@example.com',
      password: 'your-password',
    })
  })
})

describe('ShoppersDrugMartCollectorDescriptor', () => {
  it('bundles the shoppers-drugmart schema, default, and plan factory', () => {
    expect(ShoppersDrugMartCollectorDescriptor.tag).toBe('shoppers-drugmart')
    expect(ShoppersDrugMartCollectorDescriptor.configSchema).toBe(InstanceConfig)
    expect(ShoppersDrugMartCollectorDescriptor.defaultConfig).toEqual(defaultConfig)
    // The framework mints the run id and passes it as the second argument; this
    // factory ignores it (there is no per-run identity to derive), so the plan is
    // a pure function of config.
    expect(ShoppersDrugMartCollectorDescriptor.makeScrapingPlan(defaultConfig, 'test-run')).toEqual(
      scrapingPlan(defaultConfig)
    )
  })

  it('exposes kind-level display strings', () => {
    expect(ShoppersDrugMartCollectorDescriptor.display.title).toBe('Shoppers Drug Mart')
    expect(ShoppersDrugMartCollectorDescriptor.display.description).toBe(
      'Prescriptions from Shoppers Drug Mart (mypharmacy.shoppersdrugmart.ca)'
    )
  })

  it('derives the list subtitle from the configured account email', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expect(ShoppersDrugMartCollectorDescriptor.display.listSubtitle(config)).toBe(config.email)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('matches its own configs and rejects foreign ones via resourcePersistenceRuntimeIfMatches', () => {
    const runtime =
      ShoppersDrugMartCollectorDescriptor.resourcePersistenceRuntimeIfMatches(defaultConfig)
    expect(runtime?.run((context) => context.scrapingPlan)).toEqual(scrapingPlan(defaultConfig))
    expect(
      ShoppersDrugMartCollectorDescriptor.resourcePersistenceRuntimeIfMatches({
        _tag: 'fhir-r4',
        rootUrl: 'https://x',
      })
    ).toBeUndefined()
  })

  it('renders the account-email subtitle for its own config via listSubtitleIfMatches', () => {
    expect(
      ShoppersDrugMartCollectorDescriptor.listSubtitleIfMatches({
        _tag: 'shoppers-drugmart',
        email: 'member@shoppers.test',
        password: 'pw',
      })
    ).toBe('member@shoppers.test')
    expect(
      ShoppersDrugMartCollectorDescriptor.listSubtitleIfMatches({
        _tag: 'fhir-r4',
        rootUrl: 'https://x',
      })
    ).toBeUndefined()
  })
})

describe('scrapingPlan', () => {
  it('mounts the mypharmacy login page as the first page', () => {
    const plan = scrapingPlan(defaultConfig)
    expect(plan.firstPage).toEqual({
      _tag: 'Uri',
      uri: 'https://mypharmacy.shoppersdrugmart.ca/en/login',
    })
  })

  it('waits for the pcid redirect, scripts login, pauses for 2FA, opens prescriptions, and settles', () => {
    const plan = scrapingPlan({ _tag: 'shoppers-drugmart', email: 'a@b.com', password: 'secret' })
    expect(plan.stepSequence).toEqual([
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for login page',
        pattern: /:\/\/accounts\.pcid\.ca\/login/,
        timeout: Duration.seconds(30),
      },
      {
        _tag: 'Navigation',
        name: 'Entering email',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="email"]', value: 'a@b.com' },
        },
      },
      { _tag: 'Delay', name: 'Waiting to enter email', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        name: 'Entering password',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="password"]', value: 'secret' },
        },
      },
      { _tag: 'Delay', name: 'Waiting before submitting', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        name: 'Clicking submit',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Click', querySelector: 'button[type="submit"]' },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for Health Dashboard',
        pattern: /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/healthdashboard/,
        timeout: Duration.minutes(5),
      },
      {
        _tag: 'Navigation',
        name: 'Opening prescriptions page',
        action: {
          _tag: 'Open',
          source: {
            _tag: 'Uri',
            uri: 'https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/?nav=featured-services/prescription-icon',
          },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        name: 'Waiting for prescriptions to settle',
        pattern: /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/prescription-dashboard/,
        timeout: Duration.seconds(30),
      },
      { _tag: 'Delay', name: 'Done, waiting just a little longer', duration: Duration.seconds(8) },
    ])
  })

  it('interpolates the config credentials into the login fills', () => {
    const plan = scrapingPlan({
      _tag: 'shoppers-drugmart',
      email: 'user@shoppers.test',
      password: 'hunter2',
    })
    const fills = plan.stepSequence.flatMap((step) =>
      step._tag === 'Navigation' &&
      step.action._tag === 'PageAction' &&
      step.action.action.kind === 'Fill'
        ? [step.action.action.value]
        : []
    )
    expect(fills).toEqual(['user@shoppers.test', 'hunter2'])
  })
})

/**
 * The plan's entities as the framework sees them — wrapped by
 * `adoptSourceIdentity`, not the raw module singletons the entity suites
 * exercise. That distinction is the point of this block: the entity suites pin
 * the portal-JSON → R4 synthesis, and these pin what the plan does to the
 * synthesized resources afterwards (re-key under a derived local id, keep the
 * portal id as `identifier[0]`, rewrite relative references).
 */
describe('source identity', () => {
  const entityNamed = (name: string): EntityDefinition.EntityDefinition<FhirResource> => {
    const found = scrapingPlan(defaultConfig).entityDefinitions.find(
      (entity) => entity.name === name
    )
    if (found === undefined) throw new Error(`no entity named ${name}`)
    return found
  }

  const parseThrough = (name: string, url: string, body: unknown): readonly FhirResource[] =>
    Effect.runSync(entityNamed(name).parse(makeRemoteResponse({ url, body: JSON.stringify(body) })))

  const PROFILE_URL = 'https://mypharmacy.shoppersdrugmart.ca/api/profile/getProfile/'
  const STATUS_URL =
    'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescriptions/rx-uuid-1/prescription-status'

  const prescriptionPayload = {
    id: 'rx-uuid-1',
    storeId: 1414,
    patientId: 'pt-uuid-1',
    prescriptionNumber: 998877,
    brandName: 'Atorvastatin',
    chemicalName: 'atorvastatin 20mg',
    din: '02123456',
    status: { label: 'Active' },
    dispenses: [{ '0': { dispenseId: 'disp-1', status: 'COMPLETE' } }],
  }

  const parsePrescription = (): readonly FhirResource[] =>
    parseThrough('PrescriptionEntity', STATUS_URL, prescriptionPayload)

  it('keys each synthesized resource under a derived local id, portal id first', () => {
    const resources = parsePrescription()
    const request = resources.find((r) => r.resourceType === 'MedicationRequest')
    if (request?.resourceType !== 'MedicationRequest')
      throw new Error('expected a MedicationRequest')

    expect(request.id).toBe(
      localResourceId(SHOPPERS_DRUGMART_SYSTEM, 'MedicationRequest', 'rx-uuid-1')
    )
    // The portal's own id is injected as identifier[0]; the prescription-number
    // identifier the entity stamped rides along behind it.
    expect(request.identifier[0]?.value).toBe('rx-uuid-1')
    expect(request.identifier[0]?.system?.href).toBe(new URL(SHOPPERS_DRUGMART_SYSTEM).href)
    expect(request.identifier.length).toBeGreaterThan(1)
  })

  it('gives the request and its dispense distinct derived ids', () => {
    const resources = parsePrescription()
    const request = resources.find((r) => r.resourceType === 'MedicationRequest')
    const dispense = resources.find((r) => r.resourceType === 'MedicationDispense')
    if (request?.resourceType !== 'MedicationRequest') throw new Error('expected a request')
    if (dispense?.resourceType !== 'MedicationDispense') throw new Error('expected a dispense')

    expect(dispense.id).toBe(
      localResourceId(SHOPPERS_DRUGMART_SYSTEM, 'MedicationDispense', 'disp-1')
    )
    expect(request.id).not.toBe(dispense.id)
  })

  it('rewrites the subject and authorizingPrescription onto the ids their targets are adopted to', () => {
    const resources = parsePrescription()
    const request = resources.find((r) => r.resourceType === 'MedicationRequest')
    const dispense = resources.find((r) => r.resourceType === 'MedicationDispense')
    if (request?.resourceType !== 'MedicationRequest') throw new Error('expected a request')
    if (dispense?.resourceType !== 'MedicationDispense') throw new Error('expected a dispense')

    const patientId = localResourceId(SHOPPERS_DRUGMART_SYSTEM, 'Patient', 'pt-uuid-1')
    // The subject link only holds because both the minimal Patient and the
    // references to it go through the one derivation.
    expect(request.subject.reference).toBe(`Patient/${patientId}`)
    expect(dispense.subject?.reference).toBe(`Patient/${patientId}`)
    expect(dispense.authorizingPrescription[0]?.reference).toBe(`MedicationRequest/${request.id}`)
  })

  it('leaves the absolute store-locator supportingInformation URL alone', () => {
    const resources = parsePrescription()
    const request = resources.find((r) => r.resourceType === 'MedicationRequest')
    if (request?.resourceType !== 'MedicationRequest') throw new Error('expected a request')
    // An absolute foreign URL is not a relative `Type/id` reference, so the
    // rewrite must pass it through untouched.
    expect(request.supportingInformation[0]?.reference).toBe(
      'https://www.shoppersdrugmart.ca/store-locator/store/1414'
    )
  })

  it('adopts the demographic Patient under the same system but a distinct id from the subject Patient', () => {
    const [profilePatient] = parseThrough('ProfileEntity', PROFILE_URL, { pcId: 'pc-uuid-1' })
    if (profilePatient?.resourceType !== 'Patient') throw new Error('expected a Patient')

    expect(profilePatient.id).toBe(
      localResourceId(SHOPPERS_DRUGMART_SYSTEM, 'Patient', 'pc-uuid-1')
    )
    expect(profilePatient.identifier[0]?.value).toBe('pc-uuid-1')
    // pcId ≠ patientId, so the two Patient records stay distinct after adoption.
    expect(profilePatient.id).not.toBe(
      localResourceId(SHOPPERS_DRUGMART_SYSTEM, 'Patient', 'pt-uuid-1')
    )
  })
})
