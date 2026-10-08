import { Schema } from 'effect'

import * as CertificateAuthority from './certificate-authority.ts'

/**
 * Where a server's certificate stands.
 *
 * @remarks
 * `ordering` and `orderFailing` come only from a run; `notIssued` and
 * `expired` only from what a cache says, for a server without a run's state. A
 * stopped server's certificate lapses because nothing renews it, and renews
 * when the server starts: `expired` is not a failure.
 */
const StatusSchema = Schema.Literal(
  /** The cache holds no certificate from the server's CA. */
  'notIssued',
  /** The run is ordering a certificate: it holds none, or an expired one, and no order is failing. */
  'ordering',
  /** The certificate is valid, with more than a third of its lifetime left. */
  'noRenewalNeeded',
  /** The certificate is valid, with a third or less of its lifetime left; a run renews it. */
  'renewalDue',
  /** The cache's certificate has expired; it renews when the server starts. */
  'expired',
  /** The run holds no valid certificate, and its latest error, `lastError`, is an order's failure. */
  'orderFailing'
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
 * A run's latest certificate error: an order's failure (a CA rate limit, with
 * when the CA said to retry; a validation handshake that didn't reach this
 * device, with the CA's detail; a CA that couldn't be reached; or any other
 * order failure), or `cache`, a certificate or account cache on this device
 * that couldn't be read or written, which never makes the run `orderFailing`.
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
  Schema.Struct({ kind: Schema.Literal('other'), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('cache'), message: Schema.String })
)

/** A decoded {@link OrderErrorSchema}. */
type OrderError = typeof OrderErrorSchema.Type

/**
 * What the host knows about a server's certificate for its domain: its
 * status, the CA it is ordered from, the certificate held, and the run's
 * latest error since it last deployed one.
 */
const CertificateStateSchema = Schema.Struct({
  status: StatusSchema,
  issuer: CertificateAuthority.Schema,
  held: Schema.optionalWith(IssuedSchema, { as: 'Option', exact: true }),
  lastError: Schema.optionalWith(OrderErrorSchema, { as: 'Option', exact: true }),
})

/** A decoded {@link CertificateStateSchema}. */
type Type = typeof CertificateStateSchema.Type

export { CertificateStateSchema as Schema, IssuedSchema, OrderErrorSchema, StatusSchema }
export type { Issued, OrderError, Status, Type }
