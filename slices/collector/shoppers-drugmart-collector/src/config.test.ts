import { Arbitrary, Duration, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  InstanceConfig,
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
    expect(ShoppersDrugMartCollectorDescriptor.makeScrapingPlan(defaultConfig)).toEqual(
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
        pattern: /:\/\/accounts\.pcid\.ca\/login/,
        timeout: Duration.seconds(30),
      },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="email"]', value: 'a@b.com' },
        },
      },
      { _tag: 'Delay', duration: Duration.seconds(1) },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="password"]', value: 'secret' },
        },
      },
      { _tag: 'Delay', duration: Duration.seconds(1) },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Click', querySelector: 'button[type="submit"]' },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        pattern: /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/healthdashboard/,
        timeout: Duration.minutes(5),
      },
      {
        _tag: 'Navigation',
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
        pattern: /:\/\/mypharmacy\.shoppersdrugmart\.ca\/en\/prescription-dashboard/,
        timeout: Duration.seconds(30),
      },
      { _tag: 'Delay', duration: Duration.seconds(8) },
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
