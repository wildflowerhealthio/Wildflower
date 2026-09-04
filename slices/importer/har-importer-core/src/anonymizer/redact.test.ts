import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import type { TraceBody, TraceExchange } from 'web-trace-core'
import { arbitraries, jsonBody, traceExchange } from 'web-trace-core/test-helpers'
import { type JsonLeaf, type LeafVisitor, mapExchangeLeaves } from './leaves.ts'
import {
  buildRedactionPolicy,
  isCodeToken,
  isNamespaceUri,
  redactExchange,
  type RedactionPolicy,
  redactSession,
} from './redact.ts'
import { detectShape } from './shapes.ts'

const { session: sessionArbitrary } = arbitraries(fc)

const decodeBase64 = Schema.decodeSync(Schema.StringFromBase64)
const decodeBase64Url = Schema.decodeSync(Schema.StringFromBase64Url)

const SALT_A = 'test-salt-a'
const SALT_B = 'test-salt-b'

/** `JSON.parse` narrowed to `unknown` at the boundary, so no assertion is needed downstream. */
const parseUnknown = (text: string): unknown => JSON.parse(text)

/** Reads a stored JSON body through `schema`. Throws if the body was skipped — that is a test bug. */
const storedJson = <A, I>(body: TraceBody, schema: Schema.Schema<A, I>): A => {
  if (body._tag !== 'StoredBody') throw new Error('Expected a stored body')
  return Schema.decodeUnknownSync(schema)(parseUnknown(decodeBase64(body.data)))
}

/** Reads a JWT segment's claims as an open record, for asserting on claim names. */
const claimsOf = (segment: string): Record<string, unknown> =>
  Schema.decodeUnknownSync(Schema.Record({ key: Schema.String, value: Schema.Unknown }))(
    parseUnknown(decodeBase64Url(segment))
  )

/** Everything a reader of the exported exchange could actually see, as one string. */
const renderExchange = (exchange: TraceExchange): string =>
  [
    exchange.url,
    exchange.headers.map(([name, value]) => `${name}: ${value}`).join('\n'),
    exchange.body.hash,
    exchange.body._tag === 'StoredBody' ? decodeBase64(exchange.body.data) : exchange.body.reason,
  ].join('\n')

/** Every leaf the traversal visits, in visit order — the pairing key for before/after. */
const collectLeaves = (exchange: TraceExchange): Promise<readonly JsonLeaf[]> => {
  const collected: JsonLeaf[] = []
  const collecting: LeafVisitor<never> = {
    visitString: (_path, value) => Effect.sync(() => (collected.push(value), value)),
    visitJsonLeaf: (_path, value) => Effect.sync(() => (collected.push(value), value)),
  }
  return Effect.runPromise(mapExchangeLeaves(exchange, collecting).pipe(Effect.as(collected)))
}

const collectSessionLeaves = async (
  exchanges: readonly TraceExchange[]
): Promise<readonly JsonLeaf[]> => (await Promise.all(exchanges.map(collectLeaves))).flat()

/**
 * Redaction with **every** verbatim rule off unless a test asks for one, so the
 * properties below are about pseudonymization itself rather than about what a
 * carve-out let through. Both switches have to be named: the core defaults them
 * on, and a corpus that contains namespace URIs would otherwise carry some of
 * its own values into the output.
 */
const redactWith = (
  exchanges: readonly TraceExchange[],
  options: {
    readonly salt: string
    readonly enumCarveOut?: boolean
    readonly namespaceUris?: boolean
  }
): Promise<readonly TraceExchange[]> =>
  Effect.runPromise(
    buildRedactionPolicy(exchanges, {
      salt: options.salt,
      enumCarveOut: options.enumCarveOut ?? false,
      namespaceUris: options.namespaceUris ?? false,
    }).pipe(Effect.flatMap((policy) => redactSession(policy, exchanges)))
  )

/** Structure only: object keys, array cardinality, and leaf types. No values. */
const skeleton = (value: unknown): unknown => {
  if (Array.isArray(value)) return { array: value.length, of: value.map(skeleton) }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, skeleton(child)]))
  }
  return value === null ? 'null' : typeof value
}

const bodySkeleton = (exchange: TraceExchange): unknown =>
  exchange.body._tag === 'StoredBody'
    ? skeleton(JSON.parse(decodeBase64(exchange.body.data)))
    : { skipped: exchange.body.contentType }

const urlStructure = (url: string): unknown => {
  const parsed = new URL(url)
  return {
    protocol: parsed.protocol,
    host: parsed.host,
    segments: parsed.pathname.split('/').length,
    queryNames: [...parsed.searchParams.keys()],
  }
}

describe('the pseudonymizer', () => {
  test('property: no original leaf value survives as a substring of any output', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const redacted = await redactWith(session, { salt: SALT_A })
        const output = redacted.map(renderExchange).join('\n')
        // Short values are excluded on purpose: a two-character value will turn
        // up inside a long fake by chance, and a value that short is not what a
        // privacy boundary exists to protect. Every pseudonymized leaf, of any
        // length, is separately asserted never to equal itself after redaction
        // by the shape-and-injectivity properties below.
        const originals = (await collectSessionLeaves(session))
          .filter((leaf): leaf is string => typeof leaf === 'string')
          .filter((leaf) => leaf.length >= 8)
        expect(originals.length).toBeGreaterThan(0)
        for (const original of originals) expect(output).not.toContain(original)
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  test('property: every pseudonymized leaf keeps its shape class', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const redacted = await redactWith(session, { salt: SALT_A })
        const before = await collectSessionLeaves(session)
        const after = await collectSessionLeaves(redacted)
        expect(after).toHaveLength(before.length)
        for (const [index, original] of before.entries()) {
          const replacement = after[index]
          if (original === null || typeof original === 'boolean' || original === '') {
            expect(replacement).toEqual(original)
            continue
          }
          expect(typeof replacement).toBe(typeof original)
          expect(detectShape(String(replacement))).toBe(detectShape(String(original)))
        }
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  test('property: within one salt, equal inputs map to equal outputs and unequal to unequal', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const redacted = await redactWith(session, { salt: SALT_A })
        const before = await collectSessionLeaves(session)
        const after = await collectSessionLeaves(redacted)

        const forward = new Map<string, string>()
        const backward = new Map<string, string>()
        for (const [index, original] of before.entries()) {
          if (original === null || typeof original === 'boolean' || original === '') continue
          const input = String(original)
          const output = String(after[index])
          // Equal inputs → equal outputs: the correspondence that tells a
          // collector author two endpoints share a key.
          expect(forward.get(input) ?? output).toBe(output)
          // Unequal inputs → unequal outputs: no two originals may read as one.
          expect(backward.get(output) ?? input).toBe(input)
          forward.set(input, output)
          backward.set(output, input)
        }
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })

  test('property: two salts produce disjoint outputs for the same session', async () => {
    // Restricted to high-entropy identifiers: a three-digit id has a thousand
    // possible fakes, so two independent salts landing on the same one says
    // nothing about the salts.
    const highEntropy = fc.array(fc.uuid(), { minLength: 2, maxLength: 5 }).map((ids) =>
      ids.map((id, index) =>
        traceExchange({
          requestId: `req-${index}`,
          url: `https://portal.example.org/api/v2/patients/${id}`,
          body: {
            _tag: 'StoredBody',
            contentType: 'application/json',
            data: jsonBody({ id, mrn: `MRN${id.replaceAll('-', '')}` }),
            size: 64,
            hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
          },
        })
      )
    )

    await fc.assert(
      fc.asyncProperty(highEntropy, async (session) => {
        const withA = await collectSessionLeaves(await redactWith(session, { salt: SALT_A }))
        const withB = await collectSessionLeaves(await redactWith(session, { salt: SALT_B }))
        const outputsOfA = new Set(
          withA.filter((leaf): leaf is string => typeof leaf === 'string' && leaf.length >= 8)
        )
        const overlap = withB.filter(
          (leaf): leaf is string => typeof leaf === 'string' && outputsOfA.has(leaf)
        )
        expect(overlap).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  test('property: JSON keys, array cardinality, header names and URL structure survive', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const redacted = await redactWith(session, { salt: SALT_A })
        for (const [index, original] of session.entries()) {
          const after = redacted[index]
          expect(after).toBeDefined()
          if (after === undefined) continue
          expect(bodySkeleton(after)).toEqual(bodySkeleton(original))
          expect(after.headers.map(([name]) => name)).toEqual(
            original.headers.map(([name]) => name)
          )
          expect(urlStructure(after.url)).toEqual(urlStructure(original.url))
          // Status, statusText and the capture instant are facts about the
          // response, not about a person.
          expect(after.status).toBe(original.status)
          expect(after.statusText).toBe(original.statusText)
          expect(after.startedAt).toEqual(original.startedAt)
        }
      }),
      { numRuns: numRunsFor({ base: 60 }) }
    )
  })
})

describe('cross-endpoint identifier joins', () => {
  test('the same identifier under different key names lands on the same pseudonym', async () => {
    const shared = 'e4b1c0aa-1f2c-4b6a-9d3e-77a10b2c3d4e'
    const session = [
      traceExchange({
        requestId: 'req-0',
        url: 'https://portal.example.org/api/v2/patients',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          data: jsonBody({ pid: shared }),
          size: 48,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        },
      }),
      traceExchange({
        requestId: 'req-1',
        url: 'https://api.example.com/v1/observations',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          data: jsonBody({ patientId: shared, other: shared }),
          size: 96,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        },
      }),
    ]
    const [first, second] = await redactWith(session, { salt: SALT_A })
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return

    const { pid } = storedJson(first.body, Schema.Struct({ pid: Schema.String }))
    const { patientId, other } = storedJson(
      second.body,
      Schema.Struct({ patientId: Schema.String, other: Schema.String })
    )

    expect(pid).not.toBe(shared)
    expect(patientId).toBe(pid)
    expect(other).toBe(pid)
  })
})

describe('the enum carve-out', () => {
  const statusSession = (statuses: readonly string[]): readonly TraceExchange[] =>
    statuses.map((status, index) =>
      traceExchange({
        requestId: `req-${index}`,
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          data: jsonBody({ status, id: `record-${index}-8f3a11c9b2` }),
          size: 40,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        },
      })
    )

  const RecordShape = Schema.Struct({ status: Schema.String, id: Schema.String })

  const statusesOf = (exchanges: readonly TraceExchange[]): readonly string[] =>
    exchanges.map((exchange) => storedJson(exchange.body, RecordShape).status)

  const idsOf = (exchanges: readonly TraceExchange[]): readonly string[] =>
    exchanges.map((exchange) => storedJson(exchange.body, RecordShape).id)

  test('a low-cardinality path exports verbatim while its high-cardinality sibling does not', async () => {
    // Sixteen exchanges cycling three statuses: `$.status` has three distinct
    // values across the session and stays; `$.id` has sixteen and does not.
    const statuses = Array.from(
      { length: 16 },
      (_unused, index) => ['active', 'completed', 'cancelled'][index % 3] ?? 'active'
    )
    const session = statusSession(statuses)
    const redacted = await Effect.runPromise(
      buildRedactionPolicy(session, { salt: SALT_A }).pipe(
        Effect.flatMap((policy) => redactSession(policy, session))
      )
    )
    expect(statusesOf(redacted)).toEqual(statuses)
    expect(idsOf(redacted)).not.toEqual(idsOf(session))
  })

  test('a path above the threshold is pseudonymized', async () => {
    // Letter-only codes, so the code-token rule admits them and the threshold
    // is what actually decides. Digit-bearing values would be disqualified on
    // shape and this test would pass without exercising the threshold.
    const session = statusSession(['alpha', 'bravo', 'charlie', 'delta', 'echo'])
    const redacted = await Effect.runPromise(
      buildRedactionPolicy(session, { salt: SALT_A, enumThreshold: 3 }).pipe(
        Effect.flatMap((policy) => redactSession(policy, session))
      )
    )
    expect(statusesOf(redacted)).not.toEqual(statusesOf(session))
  })

  test('a per-path override wins over the threshold in both directions', async () => {
    const session = statusSession(['active', 'completed', 'active'])
    const redacted = await Effect.runPromise(
      buildRedactionPolicy(session, {
        salt: SALT_A,
        overrides: { 'body:$.status': 'pseudonymize', 'body:$.id': 'verbatim' },
      }).pipe(Effect.flatMap((policy) => redactSession(policy, session)))
    )
    expect(statusesOf(redacted)).not.toEqual(statusesOf(session))
    expect(idsOf(redacted)).toEqual(idsOf(session))
  })

  test('the policy reports its decisions for the viewer to render', async () => {
    const session = statusSession(
      Array.from({ length: 16 }, (_unused, index) => (index % 2 === 0 ? 'active' : 'completed'))
    )
    const policy = await Effect.runPromise(buildRedactionPolicy(session, { salt: SALT_A }))
    expect(policy.stats.find((stat) => stat.path === 'body:$.status')).toEqual({
      path: 'body:$.status',
      distinctValues: 2,
      verbatim: true,
      decidedBy: 'threshold',
    })
    // The id carries digits, so it is disqualified on shape before the count is
    // ever consulted — `notCode`, not `threshold`.
    expect(policy.stats.find((stat) => stat.path === 'body:$.id')).toEqual({
      path: 'body:$.id',
      distinctValues: 16,
      verbatim: false,
      decidedBy: 'notCode',
    })
  })

  test('a single-patient session does not export its email, birth date, or postal code', async () => {
    // The case a count-only carve-out got wrong. In a trace of one patient's
    // session each of these takes exactly *one* value at its path, so every
    // threshold admits it — and all three left the device as captured.
    const identifying = {
      email: 'ada@example.com',
      birthDate: '1990-05-12',
      zipPostalCode: '02139',
      phone: '+1 (617) 555-0142',
      status: 'active',
    }
    const session = [
      traceExchange({
        requestId: 'req-0',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          data: jsonBody(identifying),
          size: 120,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        },
      }),
    ]

    const redacted = await Effect.runPromise(
      buildRedactionPolicy(session, { salt: SALT_A }).pipe(
        Effect.flatMap((policy) => redactSession(policy, session))
      )
    )

    const Shape = Schema.Struct({
      email: Schema.String,
      birthDate: Schema.String,
      zipPostalCode: Schema.String,
      phone: Schema.String,
      status: Schema.String,
    })
    const redactedBody = redacted[0]?.body
    if (redactedBody === undefined) throw new Error('expected one redacted exchange')
    const out = storedJson(redactedBody, Shape)
    expect(out.email).not.toBe(identifying.email)
    expect(out.birthDate).not.toBe(identifying.birthDate)
    expect(out.zipPostalCode).not.toBe(identifying.zipPostalCode)
    expect(out.phone).not.toBe(identifying.phone)
    // The carve-out still earns its keep: a code an HttpResponseKind branches
    // on survives at the same one-distinct-value cardinality.
    expect(out.status).toBe('active')
  })

  test('one identifying value disqualifies the whole path, not just that value', async () => {
    // The carve-out is per path. A path that is a code in nine exchanges and an
    // email in the tenth cannot export the nine verbatim without exporting the
    // tenth too.
    const session = statusSession([...Array.from({ length: 9 }, () => 'active'), 'ada@example.com'])
    const policy = await Effect.runPromise(buildRedactionPolicy(session, { salt: SALT_A }))
    expect(policy.stats.find((stat) => stat.path === 'body:$.status')).toMatchObject({
      verbatim: false,
      decidedBy: 'notCode',
    })
  })

  test('nothing carrying a digit, a space, or punctuation is ever carved out', () => {
    // The rule stated as a property over the whole leaf corpus: whatever the
    // session holds, every path the policy leaves verbatim holds only code
    // tokens. This is the assertion that would catch the carve-out being
    // widened back toward a count-only rule.
    return fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        // Namespace URIs off: they are a *second* verbatim rule with its own
        // shape gate, and leaving them on would let this property pass on paths
        // the code carve-out never decided.
        const policy = await Effect.runPromise(
          buildRedactionPolicy(session, {
            salt: SALT_A,
            enumThreshold: 1_000_000,
            namespaceUris: false,
          })
        )
        for (const stat of policy.stats) {
          if (stat.verbatim) expect(stat.decidedBy).toBe('threshold')
        }
        const verbatimPaths = policy.stats.filter((stat) => stat.verbatim).map((stat) => stat.path)
        const offenders: string[] = []
        const checking: LeafVisitor<never> = {
          visitString: (path, value) =>
            Effect.sync(() => {
              if (verbatimPaths.includes(path) && !isCodeToken(value)) offenders.push(value)
              return value
            }),
          visitJsonLeaf: (path, value) =>
            Effect.sync(() => {
              const text = typeof value === 'string' ? value : JSON.stringify(value)
              if (verbatimPaths.includes(path) && !isCodeToken(text)) offenders.push(text)
              return value
            }),
        }
        await Effect.runPromise(
          Effect.forEach(session, (exchange) => mapExchangeLeaves(exchange, checking))
        )
        expect(offenders).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })
})

describe('isCodeToken', () => {
  test('admits controlled-vocabulary codes and rejects everything identifying', () => {
    // The readable statement of what the carve-out will and will not admit.
    for (const code of ['active', 'entered-in-error', 'mg', 'female', 'final', 'in_progress', '']) {
      expect(isCodeToken(code)).toBe(true)
    }
    for (const identifying of [
      'ada@example.com',
      '1990-05-12',
      '02139',
      '+1 (617) 555-0142',
      'Ada Lovelace',
      '8a3f2b1c',
      'MRN12345',
      'v2',
      '123 Elm Street',
      'a'.repeat(65),
    ]) {
      expect(isCodeToken(identifying)).toBe(false)
    }
  })
})

describe('isNamespaceUri', () => {
  test('admits URIs that name a schema and rejects URIs that address a record', () => {
    // The readable statement of the rule, in the terms the docs use.
    for (const namespace of [
      'http://schema.carebook.com/v1/fhir/identifier/medicationrequest-external-id',
      'http://schema.carebook.com/v1/fhir/coding/medication-din-code',
      'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/number-of-repeats-available',
      'http://loinc.org',
      'http://snomed.info/sct',
      'https://terminology.hl7.org/CodeSystem/v3-ActCode',
      'http://hl7.org/fhir/StructureDefinition/patient-birthTime',
      'http://www.nlm.nih.gov/research/umls/rxnorm',
      'http://unitsofmeasure.org',
      'urn:oid:2.16.840.1.113883.4.1',
    ]) {
      expect(isNamespaceUri(namespace)).toBe(true)
    }

    for (const record of [
      // A pagination link: the query string carries the patient it is about.
      'https://portal.example.org/fhir/Location?subject=Patient/8a3f2b1c&_count=20',
      // A record URL: `8a3f2b1c` is the record, not a vocabulary term.
      'http://portal.example.org/fhir/Patient/8a3f2b1c',
      // Opaque tenant and environment segments, which a "letters then digits"
      // version rule would have admitted.
      'https://portal.example.org/enduser/health/h1/fhir/wqx0/pharmacy/Location',
      // A UUID naming a system is still a generated identifier.
      'urn:uuid:e4b1c0aa-1f2c-4b6a-9d3e-77a10b2c3d4e',
      // Credentials and fragments never appear in a vocabulary URI.
      'https://user:secret@portal.example.org/fhir/coding',
      'https://portal.example.org/fhir/coding#patient-8a3f',
      // Not a URI, or not one of the two admitted schemes.
      'ftp://portal.example.org/fhir/coding',
      'active',
      'ada@example.com',
      `https://portal.example.org/${'a'.repeat(300)}`,
    ]) {
      expect(isNamespaceUri(record)).toBe(false)
    }
  })

  test('rejects a bare digit run that is not a version, so numeric ids cannot ride in', () => {
    // The shape rules cannot tell `0203` — an HL7 table number — from a record
    // id, so on an unknown host it stays hidden. Widening the shape rule to
    // admit it would readmit every numeric id.
    expect(isNamespaceUri('https://portal.example.org/CodeSystem/v2-0203')).toBe(false)
    // A published registry answers that question by being the host it is.
    expect(isNamespaceUri('http://terminology.hl7.org/CodeSystem/v2-0203')).toBe(true)
  })

  test('admits anything a trusted host serves, including a URI with a query', () => {
    // The cost of the host allowlist, stated rather than left implicit: a
    // trusted host skips *every* structural rule, so a parameterised URL on
    // one exports as captured. Acceptable because a published registry serves
    // no records — and the reason a vendor host belongs on the list only after
    // someone has read a capture from that portal.
    expect(isNamespaceUri('https://terminology.hl7.org/ValueSet/$expand?filter=ada')).toBe(true)
    expect(isNamespaceUri(`http://loinc.org/${'a'.repeat(400)}`)).toBe(true)
  })

  test('matches a trusted host exactly, so a lookalike domain is not trusted', () => {
    // The allowlist is a set of hosts, not a suffix test. Both of these read as
    // hl7.org at a glance and neither is it.
    expect(isNamespaceUri('https://hl7.org.example.com/CodeSystem/v2-0203')).toBe(false)
    expect(isNamespaceUri('https://evil.example.com/terminology.hl7.org/CodeSystem/v2-0203')).toBe(
      false
    )
    // A subdomain of a trusted host is a different host, and needs its own
    // entry — `schema.` and `schemas.carebook.com` are both listed for exactly
    // this reason.
    expect(isNamespaceUri('https://tenant.hl7.org/CodeSystem/v2-0203')).toBe(false)
  })
})

describe('the namespace-URI carve-out', () => {
  /** A bundle whose `system` names a vocabulary and whose `value` names a record. */
  const codedSession = (systems: readonly string[]): readonly TraceExchange[] =>
    systems.map((system, index) =>
      traceExchange({
        requestId: `req-${index}`,
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          data: jsonBody({ system, value: `record-${index}-8f3a11c9b2` }),
          size: 96,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        },
      })
    )

  const CodedShape = Schema.Struct({ system: Schema.String, value: Schema.String })

  const systemsOf = (exchanges: readonly TraceExchange[]): readonly string[] =>
    exchanges.map((exchange) => storedJson(exchange.body, CodedShape).system)

  const valuesOf = (exchanges: readonly TraceExchange[]): readonly string[] =>
    exchanges.map((exchange) => storedJson(exchange.body, CodedShape).value)

  const policyFor = (
    session: readonly TraceExchange[],
    namespaceUris: boolean
  ): Promise<RedactionPolicy> =>
    Effect.runPromise(
      buildRedactionPolicy(session, { salt: SALT_A, enumCarveOut: false, namespaceUris })
    )

  test('a system URI exports as captured while the identifier beside it does not', async () => {
    // The case the whole rule exists for: the URI is the label that says what
    // the code means, the value beside it is the record.
    const session = codedSession([
      'http://schema.carebook.com/v1/fhir/coding/medication-din-code',
      'http://schema.carebook.com/v1/fhir/coding/medication-form-code',
    ])

    const redacted = await redactWith(session, { salt: SALT_A, namespaceUris: true })

    expect(systemsOf(redacted)).toEqual(systemsOf(session))
    expect(valuesOf(redacted)).not.toEqual(valuesOf(session))
  })

  test('a URI path is exempt from the distinct-value threshold', async () => {
    // Eighteen distinct extension urls is what the real export held, against a
    // default threshold of twelve. Cardinality carries no signal for a value
    // that names a schema, so it does not get a say.
    const session = codedSession(
      Array.from(
        { length: 18 },
        (_unused, index) =>
          `http://schemas.carebook.com/v1/fhir/extension/field-${'a'.repeat(index + 1)}`
      )
    )

    const redacted = await redactWith(session, { salt: SALT_A, namespaceUris: true })

    expect(systemsOf(redacted)).toEqual(systemsOf(session))
  })

  test('the rule answers to its own switch, not to the code carve-out', async () => {
    const session = codedSession(['http://schema.carebook.com/v1/fhir/coding/medication-din-code'])

    // Codes on, URIs off: the URI is still hidden.
    const withoutUris = await Effect.runPromise(
      buildRedactionPolicy(session, {
        salt: SALT_A,
        enumCarveOut: true,
        namespaceUris: false,
      }).pipe(Effect.flatMap((policy) => redactSession(policy, session)))
    )
    expect(systemsOf(withoutUris)).not.toEqual(systemsOf(session))

    // Codes off, URIs on: the URI survives anyway.
    const withUris = await Effect.runPromise(
      buildRedactionPolicy(session, {
        salt: SALT_A,
        enumCarveOut: false,
        namespaceUris: true,
      }).pipe(Effect.flatMap((policy) => redactSession(policy, session)))
    )
    expect(systemsOf(withUris)).toEqual(systemsOf(session))
  })

  test('a path holding a record URL is not carved out, whatever the field is called', async () => {
    // `system` is a promise the server makes, not a fact about the value. The
    // rule reads the value.
    const session = codedSession([
      'https://portal.example.org/fhir/Location?subject=Patient/8a3f2b1c&_count=20',
    ])

    const redacted = await redactWith(session, { salt: SALT_A, namespaceUris: true })

    expect(systemsOf(redacted)).not.toEqual(systemsOf(session))
  })

  test('one record URL disqualifies the whole path, not just that value', async () => {
    // Same per-path reasoning as the code carve-out: exporting the namespaces
    // verbatim would export the record URL sitting at the same path.
    const session = codedSession([
      ...Array.from(
        { length: 9 },
        () => 'http://schema.carebook.com/v1/fhir/coding/medication-din-code'
      ),
      'https://portal.example.org/fhir/Location?subject=Patient/8a3f2b1c',
    ])

    const redacted = await redactWith(session, { salt: SALT_A, namespaceUris: true })

    expect(systemsOf(redacted)).not.toEqual(systemsOf(session))
  })

  test('the policy names the rule that decided, in both directions', async () => {
    const session = codedSession([
      'http://schema.carebook.com/v1/fhir/coding/medication-din-code',
      'http://schema.carebook.com/v1/fhir/coding/medication-form-code',
    ])

    const visible = await policyFor(session, true)
    expect(visible.stats.find((stat) => stat.path === 'body:$.system')).toEqual({
      path: 'body:$.system',
      distinctValues: 2,
      verbatim: true,
      decidedBy: 'namespaceUri',
    })

    // Hidden by its own switch reads as `namespaceUrisOff`, never as
    // `notCode` — a URI is never a code token, so the code carve-out's label
    // would point the reviewer at a switch that cannot bring it back.
    const hidden = await policyFor(session, false)
    expect(hidden.stats.find((stat) => stat.path === 'body:$.system')).toEqual({
      path: 'body:$.system',
      distinctValues: 2,
      verbatim: false,
      decidedBy: 'namespaceUrisOff',
    })
  })

  test('property: with the rule on, every value exported as captured is a namespace URI', async () => {
    // The mirror of the code carve-out's own property, and the assertion that
    // would catch the URI rule being widened toward "any URL". Codes are off
    // and the threshold is irrelevant, so the URI rule is the only thing that
    // can make a path verbatim.
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const policy = await Effect.runPromise(
          buildRedactionPolicy(session, {
            salt: SALT_A,
            enumCarveOut: false,
            namespaceUris: true,
          })
        )
        for (const stat of policy.stats) {
          if (stat.verbatim) expect(stat.decidedBy).toBe('namespaceUri')
        }

        const verbatimPaths = policy.stats.filter((stat) => stat.verbatim).map((stat) => stat.path)
        const offenders: string[] = []
        const checking: LeafVisitor<never> = {
          visitString: (path, value) =>
            Effect.sync(() => {
              if (verbatimPaths.includes(path) && value !== '' && !isNamespaceUri(value)) {
                offenders.push(value)
              }
              return value
            }),
          visitJsonLeaf: (path, value) =>
            Effect.sync(() => {
              const text = typeof value === 'string' ? value : JSON.stringify(value)
              if (verbatimPaths.includes(path) && text !== '' && !isNamespaceUri(text)) {
                offenders.push(text)
              }
              return value
            }),
        }
        await Effect.runPromise(
          Effect.forEach(session, (exchange) => mapExchangeLeaves(exchange, checking))
        )
        expect(offenders).toEqual([])
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  test('property: with the rule on, nothing but a namespace URI survives in the output', async () => {
    // The blast radius, stated as the privacy claim rather than as a diff:
    // ticking the box exposes namespace URIs and nothing else. Same
    // eight-character floor as the headline substring property, and for the
    // same reason — a short value turns up inside a long fake by chance.
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const redacted = await redactWith(session, { salt: SALT_A, namespaceUris: true })
        const output = redacted.map(renderExchange).join('\n')
        const originals = (await collectSessionLeaves(session))
          .filter((leaf): leaf is string => typeof leaf === 'string')
          .filter((leaf) => leaf.length >= 8 && !isNamespaceUri(leaf))
        for (const original of originals) expect(output).not.toContain(original)
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })
})

describe('bodies the pseudonymizer cannot walk', () => {
  test('a non-JSON body is dropped, keeping its size and naming why', async () => {
    const session = [
      traceExchange({
        headers: [['Content-Type', 'text/html']],
        body: {
          _tag: 'StoredBody',
          contentType: 'text/html',
          data: jsonBody('<html><body>Ada Lovelace, MRN 88213</body></html>'),
          size: 48,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        },
      }),
    ]
    const [redacted] = await redactWith(session, { salt: SALT_A })
    expect(redacted?.body._tag).toBe('SkippedBody')
    expect(redacted?.body.size).toBe(48)
    expect(renderExchange(redacted)).not.toContain('Lovelace')
  })

  test('the body hash is pseudonymized, so a guessed body cannot be confirmed against it', async () => {
    const hash = 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o='
    const [redacted] = await redactWith(
      [
        traceExchange({
          body: {
            _tag: 'SkippedBody',
            contentType: 'image/png',
            size: 1024,
            hash,
            reason: 'Content type outside the allowlist',
          },
        }),
      ],
      { salt: SALT_A }
    )
    expect(redacted?.body.hash).not.toBe(hash)
    expect(redacted?.body.hash).toHaveLength(hash.length)
  })
})

describe('JWTs', () => {
  const token = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiJlNGIxYzBhYS0xZjJjLTRiNmEtOWQzZS03N2ExMGIyYzNkNGUiLCJpc3MiOiJodHRwczovL2F1dGguZXhhbXBsZS5vcmciLCJleHAiOjE3MTAxNTAwNjJ9',
    'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ].join('.')

  test('a token becomes a structurally valid fake that keeps the mechanism and drops the subject', async () => {
    const session = [
      traceExchange({
        headers: [
          ['Content-Type', 'application/json'],
          ['Authorization-Token', token],
        ],
      }),
    ]
    const [redacted] = await redactWith(session, { salt: SALT_A })
    const fake = redacted?.headers.find(([name]) => name === 'Authorization-Token')?.[1] ?? ''
    expect(fake).not.toBe(token)

    const [header, payload, signature] = fake.split('.')
    expect(signature).toHaveLength(43)
    const decodedHeader = claimsOf(header ?? '')
    const decodedPayload = claimsOf(payload ?? '')

    // The mechanism survives: a collector author learns the algorithm, the
    // issuer, and which claims the endpoint expects.
    expect(decodedHeader).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(Object.keys(decodedPayload)).toEqual(['sub', 'iss', 'exp'])
    expect(decodedPayload['iss']).toBe('https://auth.example.org')
    // The subject does not.
    expect(decodedPayload['sub']).not.toBe('e4b1c0aa-1f2c-4b6a-9d3e-77a10b2c3d4e')
    expect(decodedPayload['sub']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
    expect(typeof decodedPayload['exp']).toBe('number')
  })

  test('a claim inside the token joins with the same identifier in a response body', async () => {
    const subject = 'e4b1c0aa-1f2c-4b6a-9d3e-77a10b2c3d4e'
    const session = [
      traceExchange({
        requestId: 'req-0',
        headers: [
          ['Content-Type', 'application/json'],
          ['Authorization-Token', token],
        ],
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          data: jsonBody({ patientId: subject }),
          size: 48,
          hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
        },
      }),
    ]
    const [redacted] = await redactWith(session, { salt: SALT_A })
    expect(redacted).toBeDefined()
    if (redacted === undefined) return
    const fake = redacted.headers.find(([name]) => name === 'Authorization-Token')?.[1] ?? ''
    const claims = claimsOf(fake.split('.')[1] ?? '')
    const { patientId } = storedJson(redacted.body, Schema.Struct({ patientId: Schema.String }))
    expect(claims['sub']).toBe(patientId)
  })
})

describe('redaction stability', () => {
  test('property: redacting twice through one policy is idempotent for a given exchange', async () => {
    await fc.assert(
      fc.asyncProperty(sessionArbitrary, async (session) => {
        const outcome = await Effect.runPromise(
          buildRedactionPolicy(session, { salt: SALT_A, enumCarveOut: false }).pipe(
            Effect.flatMap((policy) =>
              Effect.all(
                session.map((exchange) =>
                  Effect.all([redactExchange(policy, exchange), redactExchange(policy, exchange)])
                )
              )
            )
          )
        )
        for (const [first, second] of outcome) expect(second).toEqual(first)
      }),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  test('two policies built from the same salt and session agree', async () => {
    const session = statusSessionFixture()
    const first = await redactWith(session, { salt: SALT_A })
    const second = await redactWith(session, { salt: SALT_A })
    expect(second).toEqual(first)
  })
})

const statusSessionFixture = (): readonly TraceExchange[] => [
  traceExchange({
    requestId: 'req-0',
    body: {
      _tag: 'StoredBody',
      contentType: 'application/json',
      data: jsonBody({ id: 'record-8f3a11c9b2', status: 'active' }),
      size: 40,
      hash: 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=',
    },
  }),
]
