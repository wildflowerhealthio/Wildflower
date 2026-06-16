/**
 * Spec-drift contract test (trial: gatekeeper OAuth + discovery surface).
 *
 * It diffs two OpenAPI documents:
 *   - the Rust/axum server's spec, emitted by `utoipa` and committed at
 *     `gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json` (the source of
 *     truth — regenerate with
 *     `UPDATE_OPENAPI=1 cargo test -p gatekeeper-rust openapi_spec_snapshot_is_up_to_date`);
 *   - the TypeScript client's spec, derived live from the Effect `HttpApi`
 *     via `OpenApi.fromApi(GatekeeperApi)`.
 *
 * A raw JSON diff of the two is all-noise (utoipa uses `$ref`/`oneOf`, Effect
 * inlines/`anyOf`, adds `HttpApiDecodeError`, `additionalProperties`, titles,
 * etc.), so both are projected onto a normalized *wire shape* — per
 * path+method: parameters, request body, and per-status response body — that
 * compares only what a client/server must agree on:
 *
 *   - field presence and required-ness;
 *   - primitive KIND (string / integer / number / boolean / array / object /
 *     union) — NOT enum values, formats, or string constraints, so a client
 *     schema that narrows a server `string` to a literal union is not "drift";
 *   - union arity and member shapes (catches a missing grant);
 *   - `unknown`/`any` on either side is a wildcard (a client that accepts
 *     anything is compatible with any server shape).
 *
 * Framework noise is stripped: Effect's injected `HttpApiDecodeError` union
 * members and decode-only `400`s are ignored. See ACCEPTED_DIFFERENCES for the
 * documented, intentional exceptions.
 */

import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { OpenApi } from '@effect/platform'
import { expect, test } from 'vite-plus/test'
import { GatekeeperApi } from './index.ts'

// ---- Minimal OpenAPI shapes (loose by design; these are external JSON) ------

interface SchemaObject {
  $ref?: string
  type?: string | ReadonlyArray<string>
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
  components?: { schemas?: Record<string, SchemaObject> }
}

// ---- Normalized wire shapes -------------------------------------------------

type Shape =
  | { kind: 'any' }
  | { kind: 'none' } // framework-only / no body (e.g. HttpApiDecodeError, 302)
  | { kind: 'string' | 'integer' | 'number' | 'boolean' }
  | { kind: 'array'; items: Shape }
  | { kind: 'object'; fields: Record<string, { required: boolean; shape: Shape }> }
  | { kind: 'union'; members: ReadonlyArray<Shape> }

/** A primitive `Shape` for an OpenAPI primitive type name, else undefined. The
 * `===` comparisons narrow `t` to the literal union, so no assertion is needed. */
const primitiveShape = (t: string): Shape | undefined =>
  t === 'string' || t === 'integer' || t === 'number' || t === 'boolean' ? { kind: t } : undefined

/** Resolve a `$ref` to its component schema, mapping framework refs to markers. */
const resolveRef = (ref: string, doc: OpenApiDoc, seen: ReadonlySet<string>): Shape => {
  const name = ref.split('/').pop() ?? ''
  if (name === 'HttpApiDecodeError') return { kind: 'none' }
  if (seen.has(name)) return { kind: 'any' } // cycle guard
  const target = doc.components?.schemas?.[name]
  if (!target) return { kind: 'any' }
  return normalize(target, doc, new Set([...seen, name]))
}

/**
 * Drop framework/`null` members, flatten nested unions (`(A|B)|C` === `A|B|C` —
 * Effect folds multi-member unions pairwise), unwrap a singleton; otherwise a
 * real union.
 */
const toUnion = (members: ReadonlyArray<Shape>): Shape => {
  const flat: Array<Shape> = []
  for (const m of members) {
    if (m.kind === 'none') continue
    if (m.kind === 'union') flat.push(...m.members)
    else flat.push(m)
  }
  if (flat.length === 0) return { kind: 'none' }
  if (flat.length === 1) return flat[0]
  return { kind: 'union', members: flat }
}

const normalize = (
  schema: SchemaObject,
  doc: OpenApiDoc,
  seen: ReadonlySet<string> = new Set()
): Shape => {
  if (schema.$ref) return resolveRef(schema.$ref, doc, seen)
  if (schema.anyOf) return toUnion(schema.anyOf.map((s) => normalize(s, doc, seen)))
  if (schema.oneOf) return toUnion(schema.oneOf.map((s) => normalize(s, doc, seen)))
  // A bare `null` member (Effect emits nullable as `anyOf:[T, {type:"null"}]`);
  // nullability is dropped — optionality is carried by `required`, not the type.
  if (schema.type === 'null') return { kind: 'none' }

  const type = schema.type
  if (Array.isArray(type)) {
    // e.g. ["string", "null"] — drop null; nullability is not part of the shape.
    const kinds = type.filter((t) => t !== 'null')
    const only = kinds.length === 1 ? primitiveShape(kinds[0]) : undefined
    if (only) return only
    if (kinds.length === 0) return { kind: 'none' }
  }

  if (schema.properties || type === 'object') {
    const required = new Set(schema.required ?? [])
    const fields: Record<string, { required: boolean; shape: Shape }> = {}
    for (const [name, propSchema] of Object.entries(schema.properties ?? {})) {
      fields[name] = { required: required.has(name), shape: normalize(propSchema, doc, seen) }
    }
    return { kind: 'object', fields }
  }
  if (type === 'array')
    return {
      kind: 'array',
      items: schema.items ? normalize(schema.items, doc, seen) : { kind: 'any' },
    }
  if (typeof type === 'string') {
    const prim = primitiveShape(type)
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

/** Append human-readable drift between a server (Rust) and client (Effect) shape. */
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
const responseBody = (op: Operation, status: string, doc: OpenApiDoc): Shape => {
  const schema = firstMediaSchema(op.responses?.[status]?.content)
  if (!schema) return { kind: 'none' }
  return normalize(schema, doc)
}

const paramKey = (p: Parameter): string => `${p.in} ${p.name}`

// ---- Scope + accepted differences -------------------------------------------

const SCOPE: ReadonlyArray<readonly [string, string]> = [
  ['/.well-known/jwks.json', 'get'],
  ['/oauth/authorize', 'get'],
  ['/oauth/authorize/{id}', 'get'],
  ['/oauth/token', 'post'],
  ['/oauth/device_authorization', 'post'],
]

/**
 * Documented, intentional differences excluded from the comparison.
 *
 * `get /oauth/authorize` responses: a browser front door whose success is a 302
 * redirect (and whose errors are HTML pages), not a JSON contract. The TS side
 * models it loosely as `200 text/html`. We still compare its request
 * parameters; we do not compare its responses.
 *
 * Not listed (handled structurally, not by exception): the OAuth `error` codes
 * (client narrows the server's `string` to a literal union — compatible) and
 * the JWKS key object (client treats it as opaque `unknown` — wildcard).
 */
const RESPONSES_NOT_COMPARED = new Set<string>(['get /oauth/authorize'])

test('gatekeeper OAuth client (Effect HttpApi) matches the axum OpenAPI spec', () => {
  // Both specs are external JSON, parsed at this typed boundary into the loose
  // `OpenApiDoc` shape and never trusted beyond it (test-only).
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const effect: OpenApiDoc = JSON.parse(JSON.stringify(OpenApi.fromApi(GatekeeperApi)))
  const rustPath = fileURLToPath(
    new URL('../../../gatekeeper-rust/openapi/gatekeeper-oauth.openapi.json', import.meta.url)
  )
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const rust: OpenApiDoc = JSON.parse(fs.readFileSync(rustPath, 'utf8'))

  const drift: Array<string> = []

  for (const [path, method] of SCOPE) {
    const rustOp = rust.paths[path]?.[method]
    const effectOp = effect.paths[path]?.[method]
    if (!rustOp || !effectOp) {
      drift.push(
        `${method.toUpperCase()} ${path}: present in ${rustOp ? 'server' : 'client'} only` +
          ` (server=${Boolean(rustOp)}, client=${Boolean(effectOp)})`
      )
      continue
    }
    const where = `${method.toUpperCase()} ${path}`

    // Parameters (path + query).
    const rustParams = new Map((rustOp.parameters ?? []).map((p) => [paramKey(p), p]))
    const effectParams = new Map((effectOp.parameters ?? []).map((p) => [paramKey(p), p]))
    for (const key of new Set([...rustParams.keys(), ...effectParams.keys()])) {
      const rp = rustParams.get(key)
      const ep = effectParams.get(key)
      if (!rp || !ep) {
        drift.push(`${where} param ${key}: on ${rp ? 'server' : 'client'} only`)
        continue
      }
      if (Boolean(rp.required) !== Boolean(ep.required)) {
        drift.push(
          `${where} param ${key}: required server=${Boolean(rp.required)} client=${Boolean(ep.required)}`
        )
      }
      diffShapes(
        rp.schema ? normalize(rp.schema, rust) : { kind: 'any' },
        ep.schema ? normalize(ep.schema, effect) : { kind: 'any' },
        `${where} param ${key}`,
        drift
      )
    }

    // Request body.
    const rustReq = firstMediaSchema(rustOp.requestBody?.content)
    const effectReq = firstMediaSchema(effectOp.requestBody?.content)
    if (Boolean(rustReq) !== Boolean(effectReq)) {
      drift.push(`${where} requestBody: on ${rustReq ? 'server' : 'client'} only`)
    } else if (rustReq && effectReq) {
      diffShapes(
        normalize(rustReq, rust),
        normalize(effectReq, effect),
        `${where} requestBody`,
        drift
      )
    }

    // Responses (per status), unless this endpoint's responses are excluded.
    if (!RESPONSES_NOT_COMPARED.has(`${method} ${path}`)) {
      const statuses = new Set([
        ...Object.keys(rustOp.responses ?? {}),
        ...Object.keys(effectOp.responses ?? {}),
      ])
      for (const status of statuses) {
        const rustBody = responseBody(rustOp, status, rust)
        const effectBody = responseBody(effectOp, status, effect)
        if (rustBody.kind === 'none' && effectBody.kind === 'none') continue
        if (rustBody.kind === 'none' || effectBody.kind === 'none') {
          drift.push(
            `${where} ${status} response: body on ${rustBody.kind === 'none' ? 'client' : 'server'} only`
          )
          continue
        }
        diffShapes(rustBody, effectBody, `${where} ${status} response`, drift)
      }
    }
  }

  expect(
    drift,
    `Gatekeeper OAuth spec drift between the axum server (source of truth) and the ` +
      `Effect HttpApi client.\n` +
      `Fix the TS HttpApi in oauth.ts / jwks.ts (or, if the server changed, regenerate the ` +
      `committed spec). Differences:\n  - ${drift.join('\n  - ')}`
  ).toEqual([])
})
