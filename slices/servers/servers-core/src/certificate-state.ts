import { Schema } from 'effect'

import * as CertificateAuthority from './certificate-authority.ts'

/**
 * Where a server's certificate stands.
 *
 * @remarks
 * `ordering` and `failed` come only from a run; `none` and `expired` only from
 * a stopped server's cache. A stopped server's certificate lapses because
 * nothing renews it, and renews when the server starts: `expired` is not a
 * failure.
 */
const StatusSchema = Schema.Literal(
  /** A stopped server holds no certificate from its CA. */
  'none',
  /** The run is ordering a certificate: it holds none, or an expired one. */
  'ordering',
  /** The certificate is valid, with more than a third of its lifetime left. */
  'valid',
  /** The certificate is valid, with a third or less of its lifetime left; a run renews it. */
  'renewalDue',
  /** A stopped server's certificate has expired; it renews when the server starts. */
  'expired',
  /** The run holds no valid certificate, and its latest order failed with `lastError`. */
  'failed'
)

/** A decoded {@link StatusSchema}. */
type Status = typeof StatusSchema.Type

/**
 * The certificate a server holds from its CA: when it is valid, and its
 * fingerprint, the SHA-256 of its leaf's DER in lowercase hex.
 */
const IssuedSchema = Schema.Struct({
  notBefore: Schema.DateTimeUtc,
  notAfter: Schema.DateTimeUtc,
  fingerprint: Schema.String,
})

/** A decoded {@link IssuedSchema}. */
type Issued = typeof IssuedSchema.Type

/**
 * Why a run's latest certificate order failed: a CA rate limit, with when the
 * CA said to retry; a validation handshake that didn't reach this device, with
 * the CA's detail; a CA that couldn't be reached; or any other failure.
 */
const OrderErrorSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('rateLimited'),
    retryAfter: Schema.optionalWith(Schema.DateTimeUtc, { as: 'Option', exact: true }),
  }),
  Schema.Struct({
    kind: Schema.Literal('challengeFailed'),
    detail: Schema.optionalWith(Schema.String, { as: 'Option', exact: true }),
  }),
  Schema.Struct({ kind: Schema.Literal('caUnreachable'), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('other'), message: Schema.String })
)

/** A decoded {@link OrderErrorSchema}. */
type OrderError = typeof OrderErrorSchema.Type

/**
 * What the host knows about a server's certificate for its public host: its
 * status, the CA it is ordered from, the certificate held, and why the run's
 * latest order failed since it last deployed one.
 */
const CertificateStateSchema = Schema.Struct({
  status: StatusSchema,
  issuer: CertificateAuthority.Schema,
  issued: Schema.optionalWith(IssuedSchema, { as: 'Option', exact: true }),
  lastError: Schema.optionalWith(OrderErrorSchema, { as: 'Option', exact: true }),
})

/** A decoded {@link CertificateStateSchema}. */
type Type = typeof CertificateStateSchema.Type

export { CertificateStateSchema as Schema, IssuedSchema, OrderErrorSchema, StatusSchema }
export type { Issued, OrderError, Status, Type }
