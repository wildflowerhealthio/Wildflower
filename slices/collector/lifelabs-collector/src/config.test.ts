import { Arbitrary, Duration, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor, utilityExpectations } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  InstanceConfig,
  LifeLabsCollectorDescriptor,
  defaultConfig,
  scrapingPlan,
} from './config.ts'

const { expectRightToEqual, expectLeftToEqual } = utilityExpectations(expect)

describe('InstanceConfig', () => {
  it('decodes defaultConfig without error', () => {
    expectRightToEqual(Schema.decodeUnknownEither(InstanceConfig)(defaultConfig), defaultConfig)
  })

  it('round-trips any schema-conformant username and password', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const encoded = Schema.encodeSync(InstanceConfig)(config)
        expect(Schema.decodeSync(InstanceConfig)(encoded)).toEqual(config)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('rejects missing username', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'lifelabs', password: 'pw' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it('rejects missing password', () => {
    expectLeftToEqual(
      Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'lifelabs', username: 'user' }),
      expect.objectContaining({ _tag: 'ParseError' })
    )
  })

  it.each(['', 'has space', 'trailing ', ' leading', 'a\tb'])(
    'rejects a whitespace-carrying username %j',
    (username) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({ _tag: 'lifelabs', username, password: 'pw' }),
        expect.objectContaining({ _tag: 'ParseError' })
      )
    }
  )

  it.each([['' /* empty */], ['x'.repeat(257) /* over-long */]])(
    'rejects malformed password (len %s)',
    (password) => {
      expectLeftToEqual(
        Schema.decodeUnknownEither(InstanceConfig)({
          _tag: 'lifelabs',
          username: 'user',
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
      _tag: 'lifelabs',
      username: 'you@example.com',
      password: 'your-password',
    })
  })
})

describe('LifeLabsCollectorDescriptor', () => {
  it('bundles the lifelabs schema, default, and plan factory', () => {
    expect(LifeLabsCollectorDescriptor.tag).toBe('lifelabs')
    expect(LifeLabsCollectorDescriptor.configSchema).toBe(InstanceConfig)
    expect(LifeLabsCollectorDescriptor.defaultConfig).toEqual(defaultConfig)
    expect(LifeLabsCollectorDescriptor.makeScrapingPlan(defaultConfig)).toEqual(
      scrapingPlan(defaultConfig)
    )
  })

  it('exposes kind-level display strings', () => {
    expect(LifeLabsCollectorDescriptor.display.title).toBe('LifeLabs')
    expect(LifeLabsCollectorDescriptor.display.description).toBe(
      'Lab results from LifeLabs MyCareCompass (myvisit.lifelabs.com)'
    )
  })

  it('derives the list subtitle from the configured account username', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expect(LifeLabsCollectorDescriptor.display.listSubtitle(config)).toBe(config.username)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('matches its own configs and rejects foreign ones via resourcePersistenceRuntimeIfMatches', () => {
    const runtime = LifeLabsCollectorDescriptor.resourcePersistenceRuntimeIfMatches(defaultConfig)
    expect(runtime?.run((context) => context.scrapingPlan)).toEqual(scrapingPlan(defaultConfig))
    expect(
      LifeLabsCollectorDescriptor.resourcePersistenceRuntimeIfMatches({
        _tag: 'fhir-r4',
        rootUrl: 'https://x',
      })
    ).toBeUndefined()
  })

  it('renders the account-username subtitle for its own config via listSubtitleIfMatches', () => {
    expect(
      LifeLabsCollectorDescriptor.listSubtitleIfMatches({
        _tag: 'lifelabs',
        username: 'member@lifelabs.test',
        password: 'pw',
      })
    ).toBe('member@lifelabs.test')
    expect(
      LifeLabsCollectorDescriptor.listSubtitleIfMatches({ _tag: 'fhir-r4', rootUrl: 'https://x' })
    ).toBeUndefined()
  })
})

describe('scrapingPlan', () => {
  it('mounts the myVisit login page as the first page', () => {
    const plan = scrapingPlan(defaultConfig)
    expect(plan.firstPage).toEqual({ _tag: 'Uri', uri: 'https://myvisit.lifelabs.com/login' })
  })

  it('autofills credentials, waits for the captcha login, opens analytics, and settles', () => {
    const plan = scrapingPlan({ _tag: 'lifelabs', username: 'a@b.com', password: 'secret' })
    expect(plan.stepSequence).toEqual([
      { _tag: 'Delay', duration: Duration.seconds(2) },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="email"]', value: 'a@b.com' },
        },
      },
      { _tag: 'Delay', duration: Duration.seconds(0.25) },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'PageAction',
          action: { kind: 'Fill', querySelector: 'input[type="password"]', value: 'secret' },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        pattern: /:\/\/myvisit\.lifelabs\.com\/(?!login)/,
        timeout: Duration.minutes(5),
      },
      {
        _tag: 'Navigation',
        action: {
          _tag: 'Open',
          source: { _tag: 'Uri', uri: 'https://www.on.mycarecompass.lifelabs.com/analytics' },
        },
      },
      {
        _tag: 'AwaitPageSettled',
        pattern: /:\/\/(?:www\.)?on\.mycarecompass\.lifelabs\.com\/analytics/,
        timeout: Duration.seconds(30),
      },
      { _tag: 'Delay', duration: Duration.seconds(8) },
    ])
  })

  it('never scripts a submit Click (the captcha means the user submits)', () => {
    const plan = scrapingPlan(defaultConfig)
    const clicks = plan.stepSequence.filter(
      (step) =>
        step._tag === 'Navigation' &&
        step.action._tag === 'PageAction' &&
        step.action.action.kind === 'Click'
    )
    expect(clicks).toEqual([])
  })

  it('interpolates the config credentials into the login fills', () => {
    const plan = scrapingPlan({
      _tag: 'lifelabs',
      username: 'user@lifelabs.test',
      password: 'hunter2',
    })
    const fills = plan.stepSequence.flatMap((step) =>
      step._tag === 'Navigation' &&
      step.action._tag === 'PageAction' &&
      step.action.action.kind === 'Fill'
        ? [step.action.action.value]
        : []
    )
    expect(fills).toEqual(['user@lifelabs.test', 'hunter2'])
  })
})
