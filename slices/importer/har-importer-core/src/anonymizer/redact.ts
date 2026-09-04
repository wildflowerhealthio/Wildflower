import { Data, Effect, Schema } from 'effect'

import type { TraceExchange } from 'web-trace-core'
import type { HttpArchive } from '../har/index.ts'
import { hmac, importExportKey, type ExportKey, type WebCryptoUnavailable } from './hmac.ts'
import { type JsonLeaf, type LeafVisitor, mapEntryLeaves, mapExchangeLeaves } from './leaves.ts'
import { detectShape, fakeBase64Url, generateFake, prngFromBytes } from './shapes.ts'

/**
 * The privacy boundary of the whole Web Trace epic: turning a raw captured
 * session into one a collector author can be handed.
 *
 * @remarks
 * Redaction runs in two steps, because the enum carve-out is a session-wide
 * decision that cannot be made one exchange at a time:
 * {@link buildRedactionPolicy} counts, {@link redactExchange} rewrites.
 *
 * A policy also accumulates the value→pseudonym table as it goes. **Reuse one
 * policy for the whole export**: that table is what makes response A's `pid` and
 * response B's `patientId` land on the same fake, and it is what guarantees two
 * different originals never collide onto one pseudonym.
 *
 * The design and its stated limits are in `docs/Redaction Explanation.md`. Read
 * that before changing anything here.
 *
 * @packageDocumentation
 */

/** How many re-derivations a single value gets before the pseudonym space is declared exhausted. */
const MAX_DERIVATION_ATTEMPTS = 64

/** How deep a JWT nested inside a JWT payload is followed. */
const MAX_JWT_DEPTH = 3

/** Claims that describe the auth *mechanism* rather than the subject, and so survive. */
const STRUCTURAL_JWT_CLAIMS: ReadonlySet<string> = new Set(['alg', 'typ', 'cty', 'iss', 'aud'])

/**
 * Raised when a value's shape has no free pseudonym left.
 *
 * @remarks
 * Every pseudonym keeps its original's shape, so a shape with a small space —
 * a three-digit numeric id, a two-letter code — can genuinely run out once
 * enough distinct originals map into it. Failing is deliberate: the alternatives
 * are a collision (two different originals reading as one, which is a lie about
 * the data) or a wider value (a shape violation). Raising the enum threshold, or
 * a per-path verbatim override, is the fix.
 */
class PseudonymSpaceExhausted extends Data.TaggedError('PseudonymSpaceExhausted')<{
  readonly shape: string
  readonly attempts: number
}> {}

/** Errors {@link redactExchange} can fail with. */
type RedactionError = PseudonymSpaceExhausted | WebCryptoUnavailable

/** How a path's verbatim/pseudonymize decision was reached. */
type EnumDecision =
  | 'threshold'
  | 'override'
  | 'disabled'
  | 'notCode'
  | 'namespaceUri'
  | 'namespaceUrisOff'

/**
 * The longest value the carve-out will treat as a code.
 *
 * @remarks
 * A controlled-vocabulary code is short. Past this a letters-only run is prose —
 * a free-text note, a display name — not something an `HttpResponseKind`
 * branches on.
 */
const CODE_TOKEN_MAX_LENGTH = 64

/**
 * Letters, hyphens, and underscores only — no digits, no spaces, no punctuation.
 *
 * @remarks
 * An **allowlist**, deliberately: the carve-out has to admit only what it can
 * positively recognise as a code, because everything it fails to exclude leaves
 * the device verbatim.
 */
const CODE_TOKEN = /^[A-Za-z][A-Za-z_-]*$/

/**
 * Whether a value may be exported verbatim by the enum carve-out.
 *
 * @param value - The leaf's string form, as the counting pass recorded it
 * @returns `true` for a controlled-vocabulary code, `false` for anything else
 *
 * @remarks
 * **Cardinality alone is not enough, and assuming it was is how PHI escaped.**
 * The carve-out asks "how many distinct values does this path take"; in a trace
 * of one patient's session, that patient's email, birth date, and postal code
 * each take exactly *one* value at their path — comfortably under any threshold
 * — so a count-only rule exports all three as captured.
 *
 * So a path also has to *look like* a controlled vocabulary. A code is letters
 * and separators: `active`, `entered-in-error`, `mg`, `female`, `final`. A digit
 * disqualifies (`1990-05-12`, `02139`, `8a3f2b1c`, `MRN12345`), a space
 * disqualifies (`Ada Lovelace`), and any other character disqualifies
 * (`ada@example.com`). That covers every identifying shape `detectShape` knows
 * by construction, so the two rules cannot disagree.
 *
 * The empty string is eligible because it is structure rather than data — it is
 * preserved by {@link redactExchange} regardless, and letting one empty
 * observation disqualify a whole path would hide genuine enums.
 *
 * **The residue this does not solve**: a name that is a single lowercase word
 * (`ada`, `boston`) is indistinguishable from a code by shape, and at a
 * low-cardinality path it still exports verbatim. No reliable syntactic rule
 * separates the two; the preview surfaces every carved-out path so a reviewer
 * can override one, and the carve-out is off by default in the export UI.
 */
const isCodeToken = (value: string): boolean =>
  value === '' || (value.length <= CODE_TOKEN_MAX_LENGTH && CODE_TOKEN.test(value))

/** The longest value the carve-out will treat as a namespace URI. */
const NAMESPACE_URI_MAX_LENGTH = 256

/**
 * Version tokens a namespace path may carry, as an allowlist.
 *
 * @remarks
 * A version segment is the one place a digit belongs in a namespace path.
 * Widening this to "letters then digits" also admits `w8`, `h1`, and `wqx0` —
 * the opaque tenant segments a per-record URL is built from, which is exactly
 * what {@link isNamespaceUri} exists to reject.
 */
const VERSION_PART = /^(?:v|r|stu|dstu|fhir)\d{1,3}$/i

/**
 * An OID in `urn:oid:` form — a registered arc path, digits and dots only.
 *
 * @remarks
 * `urn:uuid:` is deliberately not admitted: a UUID naming a system is still a
 * generated identifier.
 */
const URN_OID = /^urn:oid:[0-2](?:\.(?:0|[1-9]\d*))+$/

/**
 * Hosts that publish vocabulary, and so are trusted whatever the URI's shape.
 *
 * @remarks
 * The shape rules below exist to tell a namespace from a record URL. For a host
 * that serves nothing but published terminology, the host itself already
 * answers that — and answers it better, since a real system like
 * `.../CodeSystem/v2-0203` fails the shape rules on a digit run that means an
 * HL7 table number rather than a record id.
 *
 * **Two kinds of entry sit here, and they are not equally safe.** A standards
 * body cannot serve a record URL, because serving records is not a thing it
 * does. A vendor schema host is trusted on the strength of someone having
 * looked at that portal and concluded it publishes schemas at this hostname.
 * Add a vendor host only after looking; matching is exact, so a new subdomain
 * needs a new entry and cannot arrive on its own.
 *
 * See `docs/Redaction Explanation.md` for what a trusted host costs.
 */
const TERMINOLOGY_HOSTS: ReadonlySet<string> = new Set([
  // Standards bodies and public terminology registries.
  'hl7.org',
  'www.hl7.org',
  'terminology.hl7.org',
  'loinc.org',
  'snomed.info',
  'unitsofmeasure.org',
  'dicom.nema.org',
  'nlm.nih.gov',
  'www.nlm.nih.gov',
  'www.ama-assn.org',
  'www.whocc.no',
  'fhir.infoway-inforoute.ca',
  // Portal schema hosts, added after reading a capture from that portal.
  'schema.carebook.com',
  'schemas.carebook.com',
])

/** Whether one `-`/`_`-separated part of a path segment reads as vocabulary. */
const isNamespacePart = (part: string): boolean => CODE_TOKEN.test(part) || VERSION_PART.test(part)

/**
 * Whether a path segment is built entirely of vocabulary parts.
 *
 * @remarks
 * Split before testing, so `v3-ActCode` is judged as a version token joined to
 * a code rather than rejected whole for its digit.
 */
const isNamespaceSegment = (segment: string): boolean =>
  segment.split(/[-_]/).every(isNamespacePart)

/**
 * Whether a value is a URI that names a *schema* rather than a *record*.
 *
 * @param value - The leaf's string form, as the counting pass recorded it
 * @returns `true` for a namespace URI, `false` for anything else
 *
 * @remarks
 * `Coding.system` and `Extension.url` name a schema and are the labels that
 * make a payload legible; `Bundle.link.url` addresses one record, patient id
 * included. The rule reads the **value**, never the field name — a `system`
 * holding `http://host/Patient/8a3f2b1c` must not ride in on its key.
 *
 * A value qualifies two ways: its host is a {@link TERMINOLOGY_HOSTS} entry, or
 * its shape reads as a namespace. The host check comes first and is the whole
 * decision — a trusted host means every structural rule below is skipped, query
 * string included.
 *
 * Why each clause is drawn where it is, and what the host allowlist costs, are
 * in `docs/Redaction Explanation.md`.
 */
const isNamespaceUri = (value: string): boolean => {
  if (value.startsWith('urn:')) return URN_OID.test(value)

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  // Matched on `hostname`, so a port cannot defeat the entry — and exactly, so
  // `hl7.org.example.com` is a different host rather than a suffix of one.
  if (TERMINOLOGY_HOSTS.has(parsed.hostname)) return true

  if (value.length > NAMESPACE_URI_MAX_LENGTH) return false
  if (parsed.search !== '' || parsed.hash !== '') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  // A leading `/` and a trailing one both split to an empty segment; a
  // host-only system like `http://loinc.org` is all of them.
  return parsed.pathname
    .split('/')
    .every((segment) => segment === '' || isNamespaceSegment(segment))
}

/**
 * Whether a path's observed values are namespace URIs, and so export as
 * captured when the reviewer has asked for schema URLs.
 *
 * @param values - Every distinct value the path took across the session
 * @returns `true` when the path is a namespace-URI path
 *
 * @remarks
 * At least one value has to be a namespace URI, or a path holding nothing but
 * empty strings would report itself as one. Empty strings are otherwise
 * tolerated for the same reason {@link isCodeToken} tolerates them: they are
 * preserved regardless, and letting one absent observation disqualify a path
 * would hide a genuine namespace field.
 */
const isNamespaceUriPath = (values: readonly string[]): boolean =>
  values.some(isNamespaceUri) && values.every((value) => value === '' || isNamespaceUri(value))

/**
 * What {@link buildRedactionPolicy} concluded about one path, for the viewer to
 * render and a reviewer to override.
 */
interface PathStat {
  /** The path key, e.g. `body:$.entry[].resource.status` or `header:x-request-id`. */
  readonly path: string
  /** How many distinct values this path took across the whole session. */
  readonly distinctValues: number
  /** Whether values at this path export unchanged. */
  readonly verbatim: boolean
  /** Why {@link PathStat.verbatim} has the value it does. */
  readonly decidedBy: EnumDecision
}

/** Per-path instruction that overrides {@link buildRedactionPolicy}'s own decision. */
type PathOverride = 'verbatim' | 'pseudonymize'

/**
 * Options for {@link buildRedactionPolicy}.
 */
interface RedactionOptions {
  /** Per-export salt from `mintExportSalt`. Required — an export must not reuse another's. */
  readonly salt: string
  /**
   * Distinct-value ceiling for the enum carve-out.
   *
   * @defaultValue 12
   */
  readonly enumThreshold?: number
  /**
   * Whether the enum carve-out runs at all.
   *
   * @defaultValue true
   */
  readonly enumCarveOut?: boolean
  /**
   * Whether namespace-URI paths export as captured.
   *
   * @remarks
   * Independent of {@link RedactionOptions.enumCarveOut} and of
   * {@link RedactionOptions.enumThreshold} — a namespace URI is not an enum.
   *
   * @defaultValue true
   */
  readonly namespaceUris?: boolean
  /** Per-path decisions that win over the threshold, keyed by {@link PathStat.path}. */
  readonly overrides?: Readonly<Record<string, PathOverride>>
}

/**
 * One export's redaction state: the key every pseudonym derives from, the enum
 * decisions, and the accumulating value→pseudonym table.
 *
 * @remarks
 * Hold one per export and pass it to every {@link redactExchange} call. It is
 * not a plain value — the assignment table grows as exchanges are redacted —
 * and it must never be shared between two exports, which is exactly what would
 * make them linkable.
 */
interface RedactionPolicy {
  /** What was decided about every path in the session, in first-seen order. */
  readonly stats: readonly PathStat[]
  /** Whether a path exports verbatim. Unknown paths pseudonymize. */
  readonly isVerbatim: (path: string) => boolean
  /** @internal The imported per-export HMAC key. */
  readonly key: ExportKey
  /** @internal Original value → assigned pseudonym, for this export only. */
  readonly assignments: Map<string, string>
  /** @internal Every pseudonym handed out, so no two originals share one. */
  readonly usedFakes: Set<string>
}

const decodeBase64Url = Schema.decodeSync(Schema.StringFromBase64Url)
const encodeBase64Url = Schema.encodeSync(Schema.StringFromBase64Url)

const DEFAULT_ENUM_THRESHOLD = 12

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const decodeBase64UrlSafe = (segment: string): string => {
  try {
    return decodeBase64Url(segment)
  } catch {
    return ''
  }
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isPlainDecimal = (text: string): boolean => /^-?\d+(\.\d+)?$/.test(text)

/**
 * Counts the distinct values seen at each path, then decides which paths export
 * verbatim.
 *
 * @param exchanges - Every exchange in the export, raw
 * @param options - Salt, threshold, and any per-path overrides
 * @returns A policy to pass to every {@link redactExchange} call for this export
 *
 * @remarks
 * The carve-out exists because pure pseudonymization turns `"status": "active"`
 * into noise. A status code or a unit enum is not PHI, and it is exactly what an
 * `HttpResponseKind` branches on — so a path whose values across the session
 * number at most the threshold is left alone.
 *
 * There are **two** verbatim rules, decided independently: the code carve-out
 * is shape-gated then counted, {@link isNamespaceUri} is shape-gated and not
 * counted. The URI rule is tested first, so a hidden `system` field reports
 * `namespaceUrisOff` rather than the `notCode` it would always land on — the
 * two have different fixes.
 */
const buildRedactionPolicy = (
  exchanges: readonly TraceExchange[],
  options: RedactionOptions
): Effect.Effect<RedactionPolicy, WebCryptoUnavailable> =>
  Effect.gen(function* () {
    const threshold = options.enumThreshold ?? DEFAULT_ENUM_THRESHOLD
    const carveOut = options.enumCarveOut ?? true
    const namespaceUris = options.namespaceUris ?? true
    const overrides = options.overrides ?? {}

    const seen = new Map<string, Set<string>>()
    const record = <A extends JsonLeaf>(path: string, value: A): A => {
      const values = seen.get(path) ?? new Set<string>()
      values.add(typeof value === 'string' ? value : JSON.stringify(value))
      seen.set(path, values)
      return value
    }
    const counting: LeafVisitor<never> = {
      visitString: (path, value) => Effect.sync(() => record(path, value)),
      visitJsonLeaf: (path, value) => Effect.sync(() => record(path, value)),
    }
    for (const exchange of exchanges) yield* mapExchangeLeaves(exchange, counting)

    const stats: readonly PathStat[] = [...seen].map(([path, values]) => {
      const override = overrides[path]
      if (override !== undefined) {
        return {
          path,
          distinctValues: values.size,
          verbatim: override === 'verbatim',
          decidedBy: 'override',
        }
      }
      // Settled before the code carve-out and outside it: own switch, and no
      // count. A portal with forty private extensions has forty keys, not
      // forty secrets.
      if (isNamespaceUriPath([...values])) {
        return {
          path,
          distinctValues: values.size,
          verbatim: namespaceUris,
          decidedBy: namespaceUris ? 'namespaceUri' : 'namespaceUrisOff',
        }
      }
      if (!carveOut) {
        return { path, distinctValues: values.size, verbatim: false, decidedBy: 'disabled' }
      }
      // Shape before count. A path is only a candidate for the carve-out if
      // *every* value it took looks like a code — one identifying value is
      // enough to disqualify the path, because the carve-out is per path and
      // exporting the rest verbatim would export that one too.
      if (![...values].every(isCodeToken)) {
        return { path, distinctValues: values.size, verbatim: false, decidedBy: 'notCode' }
      }
      return {
        path,
        distinctValues: values.size,
        verbatim: values.size <= threshold,
        decidedBy: 'threshold',
      }
    })
    const verbatimPaths = new Set(stats.filter((stat) => stat.verbatim).map((stat) => stat.path))

    return {
      stats,
      isVerbatim: (path: string): boolean => verbatimPaths.has(path),
      key: yield* importExportKey(options.salt),
      assignments: new Map<string, string>(),
      usedFakes: new Set<string>(),
    }
  })

/**
 * Assigns — or recalls — the pseudonym for one original string.
 *
 * @param policy - The export's policy, whose assignment table this reads and extends
 * @param original - The value to replace
 * @param depth - JWT nesting depth, to bound recursion through nested tokens
 * @param accept - Extra acceptance test a candidate must pass, on top of the
 *   built-in ones
 * @returns The pseudonym, stable for the rest of the export
 *
 * @remarks
 * Candidates are re-derived until one is acceptable, which means: not equal to
 * the original (so no value survives itself), still of the original's shape (the
 * guarantee the whole design rests on), and not already handed to a different
 * original (so unequal inputs stay unequal). The first acceptable candidate is
 * remembered for the rest of the export.
 */
const pseudonymizeString = (
  policy: RedactionPolicy,
  original: string,
  depth: number,
  accept: (candidate: string) => boolean = () => true
): Effect.Effect<string, RedactionError> =>
  Effect.gen(function* () {
    const remembered = policy.assignments.get(original)
    if (remembered !== undefined) return remembered

    const shape = detectShape(original)
    for (let attempt = 0; attempt < MAX_DERIVATION_ATTEMPTS; attempt += 1) {
      const bytes = yield* hmac(policy.key, `${attempt} ${original}`)
      const candidate =
        shape === 'jwt' && depth < MAX_JWT_DEPTH
          ? yield* fakeJwt(policy, original, bytes, depth)
          : generateFake(shape, original, bytes)
      if (
        candidate !== original &&
        detectShape(candidate) === shape &&
        !policy.usedFakes.has(candidate) &&
        accept(candidate)
      ) {
        policy.assignments.set(original, candidate)
        policy.usedFakes.add(candidate)
        return candidate
      }
    }
    return yield* Effect.fail(
      new PseudonymSpaceExhausted({ shape, attempts: MAX_DERIVATION_ATTEMPTS })
    )
  })

/**
 * Rebuilds a JWT as a structurally valid fake with fake claims.
 *
 * @param policy - The export's policy, so claims join with the rest of the export
 * @param original - The token being replaced
 * @param bytes - Digest bytes for this derivation attempt
 * @param depth - Current nesting depth
 * @returns A three-segment token whose header and payload are valid JSON
 *
 * @remarks
 * A collector author needs to learn the auth *mechanism* — that this endpoint
 * takes a bearer JWT, signed with this algorithm, carrying these claim names —
 * without receiving the token. So `alg`, `typ`, `cty`, `iss` and `aud` survive,
 * every other claim is pseudonymized through the same table as the rest of the
 * export, and the signature becomes noise of the same length. A token whose
 * segments are not decodable JSON falls back to same-length base64url noise.
 */
const fakeJwt = (
  policy: RedactionPolicy,
  original: string,
  bytes: Uint8Array,
  depth: number
): Effect.Effect<string, RedactionError> =>
  Effect.gen(function* () {
    const [headerSegment = '', payloadSegment = '', signatureSegment = ''] = original.split('.')
    const header = parseJson(decodeBase64UrlSafe(headerSegment))
    const payload = parseJson(decodeBase64UrlSafe(payloadSegment))
    if (!isJsonObject(header) || !isJsonObject(payload)) {
      return generateFake('jwt', original, bytes)
    }

    const rebuildClaims = (
      claims: Record<string, unknown>
    ): Effect.Effect<Record<string, unknown>, RedactionError> =>
      Effect.forEach(Object.entries(claims), ([claim, value]) =>
        (STRUCTURAL_JWT_CLAIMS.has(claim) || typeof value === 'boolean' || value === null
          ? Effect.succeed(value)
          : pseudonymizeUnknown(policy, value, depth + 1)
        ).pipe(Effect.map((mapped) => [claim, mapped] as const))
      ).pipe(Effect.map((entries) => Object.fromEntries(entries)))

    return [
      encodeBase64Url(JSON.stringify(yield* rebuildClaims(header))),
      encodeBase64Url(JSON.stringify(yield* rebuildClaims(payload))),
      fakeBase64Url(prngFromBytes(bytes), signatureSegment.length),
    ].join('.')
  })

/** Pseudonymizes a JWT claim, which may be a scalar or a nested structure. */
const pseudonymizeUnknown = (
  policy: RedactionPolicy,
  value: unknown,
  depth: number
): Effect.Effect<unknown, RedactionError> => {
  if (typeof value === 'string') {
    return value === '' ? Effect.succeed(value) : pseudonymizeString(policy, value, depth)
  }
  if (typeof value === 'number') return pseudonymizeNumber(policy, value, depth)
  if (Array.isArray(value)) {
    return Effect.forEach(value, (element) => pseudonymizeUnknown(policy, element, depth))
  }
  if (isJsonObject(value)) {
    return Effect.forEach(Object.entries(value), ([key, child]) =>
      pseudonymizeUnknown(policy, child, depth).pipe(Effect.map((mapped) => [key, mapped] as const))
    ).pipe(Effect.map((entries) => Object.fromEntries(entries)))
  }
  return Effect.succeed(value)
}

/**
 * Pseudonymizes a numeric leaf through the same value table the string leaves
 * use, so a number and its string spelling land on the same fake.
 *
 * @param policy - The export's policy
 * @param original - The number to replace
 * @param depth - JWT nesting depth, passed through
 * @returns A number of the same spelling shape
 *
 * @remarks
 * A number whose canonical spelling is a plain decimal goes through the string
 * pipeline, with candidates rejected unless `String(Number(candidate))` is the
 * candidate itself — that is what keeps a generated leading zero from silently
 * changing the digit count, and what carries string injectivity over to numbers.
 * Anything in exponent notation gets a value of the same sign and order of
 * magnitude instead, since its spelling has no character-class structure worth
 * imitating.
 */
const pseudonymizeNumber = (
  policy: RedactionPolicy,
  original: number,
  depth: number
): Effect.Effect<number, RedactionError> =>
  Effect.gen(function* () {
    const text = String(original)
    if (isPlainDecimal(text)) {
      const fake = yield* pseudonymizeString(
        policy,
        text,
        depth,
        (candidate) => String(Number(candidate)) === candidate
      )
      return Number(fake)
    }
    const prng = prngFromBytes(yield* hmac(policy.key, `n ${text}`))
    const mantissa = 1 + (prng.nextUint32() / 0x1_0000_0000) * 9
    const exponent = Math.floor(Math.log10(Math.abs(original)))
    return Math.sign(original) * mantissa * 10 ** exponent
  })

/**
 * Rewrites one exchange against a policy.
 *
 * @param policy - The export's policy from {@link buildRedactionPolicy}
 * @param exchange - The raw exchange to redact
 * @returns The redacted exchange, same shape throughout
 *
 * @remarks
 * Safe to call on the same exchange twice, and safe to call on exchanges in any
 * order — the assignment table makes the mapping stable either way. Empty
 * strings, `null`, and booleans pass through: they carry no identity, and their
 * one or two possible values fall under any enum threshold anyway.
 */
const redactExchange = (
  policy: RedactionPolicy,
  exchange: TraceExchange
): Effect.Effect<TraceExchange, RedactionError> => {
  const visitor: LeafVisitor<RedactionError> = {
    visitString: (path, value) =>
      value === '' || policy.isVerbatim(path)
        ? Effect.succeed(value)
        : pseudonymizeString(policy, value, 0),
    visitJsonLeaf: (path, value) => {
      if (value === null || typeof value === 'boolean' || value === '') return Effect.succeed(value)
      if (policy.isVerbatim(path)) return Effect.succeed(value)
      return typeof value === 'number'
        ? pseudonymizeNumber(policy, value, 0)
        : pseudonymizeString(policy, value, 0)
    },
  }
  return mapExchangeLeaves(exchange, visitor)
}

/**
 * Rewrites a whole session against a policy, in order.
 *
 * @param policy - The export's policy from {@link buildRedactionPolicy}
 * @param exchanges - The raw exchanges, typically the same list the policy was built from
 * @returns The redacted exchanges, in the order given
 */
const redactSession = (
  policy: RedactionPolicy,
  exchanges: readonly TraceExchange[]
): Effect.Effect<readonly TraceExchange[], RedactionError> =>
  Effect.forEach(exchanges, (exchange) => redactExchange(policy, exchange))

/**
 * The visitor {@link redactEntry} and {@link buildPolicyForLog}'s rewriting
 * pass share — {@link buildRedactionPolicy}'s counter reuses the same shape
 * with `Effect.sync` visitors, so the two passes cannot see different paths.
 */
const redactionVisitor = (policy: RedactionPolicy): LeafVisitor<RedactionError> => ({
  visitString: (path, value) =>
    value === '' || policy.isVerbatim(path)
      ? Effect.succeed(value)
      : pseudonymizeString(policy, value, 0),
  visitJsonLeaf: (path, value) => {
    if (value === null || typeof value === 'boolean' || value === '') return Effect.succeed(value)
    if (policy.isVerbatim(path)) return Effect.succeed(value)
    return typeof value === 'number'
      ? pseudonymizeNumber(policy, value, 0)
      : pseudonymizeString(policy, value, 0)
  },
})

/**
 * Rewrites one archive entry against a policy.
 *
 * @param policy - The export's policy from {@link buildPolicyForLog}
 * @param entry - The raw archive entry to redact
 * @returns The redacted entry, same shape throughout
 *
 * @remarks
 * The HAR-native counterpart to {@link redactExchange}. Same semantics: safe to
 * call twice, safe to call in any order, empty strings and booleans pass
 * through, a non-JSON body becomes an absent one at the redaction boundary.
 */
const redactEntry = (
  policy: RedactionPolicy,
  entry: HttpArchive.Entry
): Effect.Effect<HttpArchive.Entry, RedactionError> =>
  mapEntryLeaves(entry, redactionVisitor(policy))

/**
 * Rewrites a whole archive against a policy, in order.
 *
 * @param policy - The export's policy from {@link buildPolicyForLog}
 * @param log - The raw archive, typically the same log the policy was built from
 * @returns The redacted archive, with entries in the order given
 */
const redactLog = (
  policy: RedactionPolicy,
  log: HttpArchive.Log
): Effect.Effect<HttpArchive.Log, RedactionError> =>
  Effect.map(
    Effect.forEach(log.entries, (entry) => redactEntry(policy, entry)),
    (entries) => ({ version: log.version, entries })
  )

/**
 * Counts the distinct values seen at each entry's leaves, then decides which
 * paths export verbatim.
 *
 * @param log - The archive to redact
 * @param options - Salt, threshold, and any per-path overrides
 * @returns A policy to pass to every {@link redactEntry} call for this export
 *
 * @remarks
 * The HAR-native counterpart to {@link buildRedactionPolicy}. Shares every
 * decision rule (the code carve-out, {@link isNamespaceUriPath}, the threshold,
 * per-path overrides) — the only difference is what the counting pass walks.
 */
const buildPolicyForLog = (
  log: HttpArchive.Log,
  options: RedactionOptions
): Effect.Effect<RedactionPolicy, WebCryptoUnavailable> =>
  Effect.gen(function* () {
    const threshold = options.enumThreshold ?? DEFAULT_ENUM_THRESHOLD
    const carveOut = options.enumCarveOut ?? true
    const namespaceUris = options.namespaceUris ?? true
    const overrides = options.overrides ?? {}

    const seen = new Map<string, Set<string>>()
    const record = <A extends JsonLeaf>(path: string, value: A): A => {
      const values = seen.get(path) ?? new Set<string>()
      values.add(typeof value === 'string' ? value : JSON.stringify(value))
      seen.set(path, values)
      return value
    }
    const counting: LeafVisitor<never> = {
      visitString: (path, value) => Effect.sync(() => record(path, value)),
      visitJsonLeaf: (path, value) => Effect.sync(() => record(path, value)),
    }
    for (const entry of log.entries) yield* mapEntryLeaves(entry, counting)

    const stats: readonly PathStat[] = [...seen].map(([path, values]) => {
      const override = overrides[path]
      if (override !== undefined) {
        return {
          path,
          distinctValues: values.size,
          verbatim: override === 'verbatim',
          decidedBy: 'override',
        }
      }
      if (isNamespaceUriPath([...values])) {
        return {
          path,
          distinctValues: values.size,
          verbatim: namespaceUris,
          decidedBy: namespaceUris ? 'namespaceUri' : 'namespaceUrisOff',
        }
      }
      if (!carveOut) {
        return { path, distinctValues: values.size, verbatim: false, decidedBy: 'disabled' }
      }
      if (![...values].every(isCodeToken)) {
        return { path, distinctValues: values.size, verbatim: false, decidedBy: 'notCode' }
      }
      return {
        path,
        distinctValues: values.size,
        verbatim: values.size <= threshold,
        decidedBy: 'threshold',
      }
    })
    const verbatimPaths = new Set(stats.filter((stat) => stat.verbatim).map((stat) => stat.path))

    return {
      stats,
      isVerbatim: (path: string): boolean => verbatimPaths.has(path),
      key: yield* importExportKey(options.salt),
      assignments: new Map<string, string>(),
      usedFakes: new Set<string>(),
    }
  })

export {
  buildPolicyForLog,
  buildRedactionPolicy,
  CODE_TOKEN_MAX_LENGTH,
  DEFAULT_ENUM_THRESHOLD,
  type EnumDecision,
  isCodeToken,
  isNamespaceUri,
  isNamespaceUriPath,
  NAMESPACE_URI_MAX_LENGTH,
  type PathOverride,
  TERMINOLOGY_HOSTS,
  type PathStat,
  PseudonymSpaceExhausted,
  redactEntry,
  redactExchange,
  redactLog,
  type RedactionError,
  type RedactionOptions,
  type RedactionPolicy,
  redactSession,
}
