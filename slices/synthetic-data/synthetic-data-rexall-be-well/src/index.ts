/**
 * The Rexall Be Well synthetic data generator: a `synthetic-data-fundamentals`
 * `Story`, filled under a `RexallAccount`, as the HAR a letsbewell.ca session
 * exports (`RexallHar.render`) — the carebook profile and the STU3
 * prescriptions searchset, in the dialect `rexall-be-well-source` reads.
 *
 * Deterministic: the same as-of day gives byte-identical output.
 *
 * @packageDocumentation
 */
export type { RexallAccount } from './rexall-account.ts'
export * as RexallHar from './rexall-har.ts'
