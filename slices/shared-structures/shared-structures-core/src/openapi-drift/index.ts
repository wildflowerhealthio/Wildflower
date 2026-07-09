/**
 * Generic OpenAPI wire-shape drift comparison, shared across slices.
 *
 * Given two **already-dereferenced** OpenAPI documents — a `server` (the source
 * of truth) and a `client` (a consumer) — it projects each onto a normalized
 * *wire shape* and reports where they disagree on what a client and server must
 * actually agree on:
 *
 *   - field presence and required-ness;
 *   - primitive KIND (string / integer / number / boolean / array / object /
 *     union) — NOT enum values, formats, or string constraints, so a client
 *     that narrows the server's `string` to a literal union is not "drift";
 *   - union arity and member shapes (catches a missing variant);
 *   - `unknown`/`any` on either side is a wildcard.
 *
 * Framework noise is stripped: Effect's injected `HttpApiDecodeError` (detected
 * by its `_tag`, even once inlined) and the resulting decode-only `400`s are
 * ignored. `$ref` resolution is the caller's job — dereference both docs (e.g.
 * with `@apidevtools/json-schema-ref-parser`) before calling, so this module
 * stays free of IO/deps and only sees inlined schemas.
 *
 * It encodes a *compatibility policy*, not a full OpenAPI diff: it answers "can
 * this client talk to this server?", not "what changed between two versions?".
 */

// ---- Minimal OpenAPI shapes (loose by design; external JSON, post-deref) ----

interface SchemaObject {
  type?: string | ReadonlyArray<string>
  enum?: ReadonlyArray<unknown>
  properties?: Record<string, SchemaObject>
  required?: ReadonlyArray<string>
  items?: SchemaObject
  anyOf?: ReadonlyArray<SchemaObject>
  oneOf?: ReadonlyArray<SchemaObject>
}
interface MediaType {
  schema?: SchemaObject
}
interface Parameter {
  name: string
  in: string
  required?: boolean
  schema?: SchemaObject
}
interface Operation {
  parameters?: ReadonlyArray<Parameter>
  requestBody?: { content?: Record<string, MediaType> }
  responses?: Record<string, { content?: Record<string, MediaType> }>
}
interface OpenApiDoc {
  paths: Record<string, Record<string, Operation>>
}

interface SpecDriftOptions {
  /** `(path, method)` pairs to compare; both must be lowercase method. */
  scope: ReadonlyArray<readonly [string, string]>
  /**
   * `"method path"` keys whose *responses* are not compared (e.g. browser
   * redirects with no JSON body). Their parameters/request bodies still are.
   */
  responsesNotCompared?: ReadonlySet<string>
  /**
   * `"method path"` keys whose *request bodies* are not compared (e.g. a raw
   * binary upload that utoipa renders as `Vec<u8>` — `integer[]` — while Effect
   * emits `{type:'string',format:'binary'}`, which cannot normalize equal).
   * Their parameters/responses still are. Pin the excluded body with a focused
   * test so it can't silently drift.
   */
  requestsNotCompared?: ReadonlySet<string>
}

// ---- Normalized wire shapes -------------------------------------------------

type Shape =
  | { kind: 'any' }
  | { kind: 'none' } // framework-only / no body (HttpApiDecodeError, 302, ...)
  | { kind: 'string' | 'integer' | 'number' | 'boolean' }
  | { kind: 'array'; items: Shape }
  | { kind: 'object'; fields: Record<string, { required: boolean; shape: Shape }> }
  | { kind: 'union'; members: ReadonlyArray<Shape> }

/** A primitive `Shape` for an OpenAPI primitive type name, else undefined. The
 * `===` comparisons narrow `t` to the literal union, so no assertion is needed. */
const maybePrimitiveShapeFromName = (t: string): Shape | undefined =>
  t === 'string' || t === 'integer' || t === 'number' || t === 'boolean' ? { kind: t } : undefined

/** Effect injects `HttpApiDecodeError` on decode failures; it is framework noise,
 * recognizable even once inlined by its `_tag` literal. */
const isDecodeError = (schema: SchemaObject): boolean => {
  const tag = schema.properties?._tag?.enum
  return tag?.length === 1 && tag[0] === 'HttpApiDecodeError'
}

/**
 * Drop framework/`null` members, flatten arbitrarily-nested unions
 * (`(A|B)|C` === `A|B|C` — Effect folds multi-member unions pairwise), unwrap a
 * singleton; otherwise a real union.
 */
const toUnion = (members: ReadonlyArray<Shape>): Shape => {
  const flat: Array<Shape> = []
  const add = (m: Shape): void => {
    if (m.kind === 'none') return
    if (m.kind === 'union') m.members.forEach(add)
    else flat.push(m)
  }
  members.forEach(add)
  if (flat.length === 0) return { kind: 'none' }
  if (flat.length === 1) return flat[0]
  return { kind: 'union', members: flat }
}

const normalize = (schema: SchemaObject): Shape => {
  if (isDecodeError(schema)) return { kind: 'none' }
  if (schema.anyOf) return toUnion(schema.anyOf.map(normalize))
  if (schema.oneOf) return toUnion(schema.oneOf.map(normalize))
  // A bare `null` member (Effect emits nullable as `anyOf:[T, {type:"null"}]`);
  // nullability is dropped — optionality is carried by `required`, not the type.
  if (schema.type === 'null') return { kind: 'none' }

  const type = schema.type
  if (Array.isArray(type)) {
    // e.g. ["string", "null"] — drop null; nullability is not part of the shape.
    const kinds = type.filter((t) => t !== 'null')
    const only = kinds.length === 1 ? maybePrimitiveShapeFromName(kinds[0]) : undefined
    if (only) return only
    if (kinds.length === 0) return { kind: 'none' }
  }

  if (schema.properties || type === 'object') {
    const required = new Set(schema.required ?? [])
    const fields: Record<string, { required: boolean; shape: Shape }> = {}
    for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
      fields[name] = { required: required.has(name), shape: normalize(propSchema) }
    }
    return { kind: 'object', fields }
  }
  if (type === 'array')
    return { kind: 'array', items: schema.items ? normalize(schema.items) : { kind: 'any' } }
  if (typeof type === 'string') {
    const prim = maybePrimitiveShapeFromName(type)
    if (prim) return prim
  }
  // Empty schema ({}), Schema.Unknown, or anything we don't model → wildcard.
  return { kind: 'any' }
}

// ---- Structural comparison --------------------------------------------------

const shapesEqual = (a: Shape, b: Shape): boolean => {
  if (a.kind === 'any' || b.kind === 'any') return true
  if (a.kind !== b.kind) return false
  if (a.kind === 'object' && b.kind === 'object') {
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
    for (const k of keys) {
      const fa = a.fields[k]
      const fb = b.fields[k]
      if (!fa || !fb || fa.required !== fb.required || !shapesEqual(fa.shape, fb.shape))
        return false
    }
    return true
  }
  if (a.kind === 'array' && b.kind === 'array') return shapesEqual(a.items, b.items)
  // Greedy first-match pairing — adequate while union members are structurally
  // distinct. It can report a false "no match" if a wildcard (`any`) member
  // makes the pairing ambiguous; revisit with bipartite matching if a union
  // ever contains an `unknown`-typed member. `diffShapes` shares this caveat.
  if (a.kind === 'union' && b.kind === 'union') {
    if (a.members.length !== b.members.length) return false
    const used = new Set<number>()
    return a.members.every((am) => {
      const i = b.members.findIndex((bm, idx) => !used.has(idx) && shapesEqual(am, bm))
      if (i < 0) return false
      used.add(i)
      return true
    })
  }
  return true // same primitive kind
}

const shapeStr = (s: Shape): string => {
  if (s.kind === 'object') {
    return `{${Object.entries(s.fields)
      .map(([k, v]) => `${k}${v.required ? '' : '?'}: ${shapeStr(v.shape)}`)
      .join(', ')}}`
  }
  if (s.kind === 'array') return `${shapeStr(s.items)}[]`
  if (s.kind === 'union') return s.members.map(shapeStr).join(' | ')
  return s.kind
}

/** Append human-readable drift between a server and client shape. */
const diffShapes = (server: Shape, client: Shape, loc: string, out: Array<string>): void => {
  if (server.kind === 'any' || client.kind === 'any') return
  if (server.kind !== client.kind) {
    out.push(`${loc}: kind server=${server.kind} client=${client.kind}`)
    return
  }
  if (server.kind === 'object' && client.kind === 'object') {
    for (const k of Object.keys(server.fields)) {
      if (!(k in client.fields)) out.push(`${loc}.${k}: on server, MISSING from client`)
    }
    for (const k of Object.keys(client.fields)) {
      if (!(k in server.fields)) out.push(`${loc}.${k}: on client, MISSING from server`)
    }
    for (const k of Object.keys(server.fields)) {
      const fc = client.fields[k]
      if (!fc) continue
      const fs2 = server.fields[k]
      if (fs2.required !== fc.required) {
        out.push(`${loc}.${k}: required server=${fs2.required} client=${fc.required}`)
      }
      diffShapes(fs2.shape, fc.shape, `${loc}.${k}`, out)
    }
    return
  }
  if (server.kind === 'array' && client.kind === 'array') {
    diffShapes(server.items, client.items, `${loc}[]`, out)
    return
  }
  if (server.kind === 'union' && client.kind === 'union') {
    const used = new Set<number>()
    for (const sm of server.members) {
      const i = client.members.findIndex((cm, idx) => !used.has(idx) && shapesEqual(sm, cm))
      if (i >= 0) used.add(i)
      else out.push(`${loc}: union member only on server: ${shapeStr(sm)}`)
    }
    client.members.forEach((cm, idx) => {
      if (!used.has(idx)) out.push(`${loc}: union member only on client: ${shapeStr(cm)}`)
    })
  }
}

// ---- Per-operation projection helpers ---------------------------------------

const firstMediaSchema = (content?: Record<string, MediaType>): SchemaObject | undefined => {
  if (!content) return undefined
  const first = Object.values(content)[0]
  return first?.schema
}

/** The normalized response body for a status, or `none` if absent/decode-only. */
const responseBody = (op: Operation, status: string): Shape => {
  const schema = firstMediaSchema(op.responses?.[status]?.content)
  if (!schema) return { kind: 'none' }
  return normalize(schema)
}

const paramKey = (p: Parameter): string => `${p.in} ${p.name}`

/**
 * Compare two already-dereferenced OpenAPI docs on wire shape, scoped to
 * `options.scope`. `server` is the source of truth, `client` the consumer.
 * Returns drift descriptions (empty array = compatible). Also flags any endpoint
 * present in BOTH docs but absent from `scope`, so a newly-added route can't
 * silently go un-compared.
 */
const collectSpecDrift = (
  server: OpenApiDoc,
  client: OpenApiDoc,
  options: SpecDriftOptions
): Array<string> => {
  const {
    scope,
    responsesNotCompared = new Set<string>(),
    requestsNotCompared = new Set<string>(),
  } = options
  const drift: Array<string> = []

  // Stale-scope guard.
  const scoped = new Set(scope.map(([p, m]) => `${m} ${p}`))
  for (const [p, ops] of Object.entries(server.paths)) {
    for (const m of Object.keys(ops)) {
      if (client.paths[p]?.[m] && !scoped.has(`${m} ${p}`)) {
        drift.push(`${m.toUpperCase()} ${p}: present in both specs but not in scope — add it`)
      }
    }
  }

  for (const [path, method] of scope) {
    const serverOp = server.paths[path]?.[method]
    const clientOp = client.paths[path]?.[method]
    if (!serverOp || !clientOp) {
      drift.push(
        `${method.toUpperCase()} ${path}: present in ${serverOp ? 'server' : 'client'} only`
      )
      continue
    }
    const where = `${method.toUpperCase()} ${path}`

    // Parameters (path + query).
    const serverParams = new Map((serverOp.parameters ?? []).map((p) => [paramKey(p), p]))
    const clientParams = new Map((clientOp.parameters ?? []).map((p) => [paramKey(p), p]))
    for (const key of new Set([...serverParams.keys(), ...clientParams.keys()])) {
      const sp = serverParams.get(key)
      const cp = clientParams.get(key)
      if (!sp || !cp) {
        drift.push(`${where} param ${key}: on ${sp ? 'server' : 'client'} only`)
        continue
      }
      if (Boolean(sp.required) !== Boolean(cp.required)) {
        drift.push(
          `${where} param ${key}: required server=${Boolean(sp.required)} client=${Boolean(cp.required)}`
        )
      }
      diffShapes(
        sp.schema ? normalize(sp.schema) : { kind: 'any' },
        cp.schema ? normalize(cp.schema) : { kind: 'any' },
        `${where} param ${key}`,
        drift
      )
    }

    // Request body, unless this endpoint's request body is excluded.
    if (!requestsNotCompared.has(`${method} ${path}`)) {
      const serverReq = firstMediaSchema(serverOp.requestBody?.content)
      const clientReq = firstMediaSchema(clientOp.requestBody?.content)
      if (Boolean(serverReq) !== Boolean(clientReq)) {
        drift.push(`${where} requestBody: on ${serverReq ? 'server' : 'client'} only`)
      } else if (serverReq && clientReq) {
        diffShapes(normalize(serverReq), normalize(clientReq), `${where} requestBody`, drift)
      }
    }

    // Responses (per status), unless this endpoint's responses are excluded.
    if (!responsesNotCompared.has(`${method} ${path}`)) {
      const statuses = new Set([
        ...Object.keys(serverOp.responses ?? {}),
        ...Object.keys(clientOp.responses ?? {}),
      ])
      for (const status of statuses) {
        const serverBody = responseBody(serverOp, status)
        const clientBody = responseBody(clientOp, status)
        if (serverBody.kind === 'none' && clientBody.kind === 'none') continue
        if (serverBody.kind === 'none' || clientBody.kind === 'none') {
          drift.push(
            `${where} ${status} response: body on ${serverBody.kind === 'none' ? 'client' : 'server'} only`
          )
          continue
        }
        diffShapes(serverBody, clientBody, `${where} ${status} response`, drift)
      }
    }
  }

  return drift
}

export { collectSpecDrift, type OpenApiDoc, type SchemaObject, type SpecDriftOptions }
