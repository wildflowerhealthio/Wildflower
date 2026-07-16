/**
 * How the runner labels one resource in telemetry and in the `partial`
 * failure summary, without the runner ever naming a collector's resource
 * union. Produced by the descriptor's `describeResource` (see
 * `CollectorDescriptor`).
 *
 * - `label`: a free-form human/telemetry string, **not** a discriminant.
 *   For FHIR it happens to hold the `resourceType`, but nothing switches
 *   on it — it only names the resource in spans and failure summaries.
 *   (Deliberately not called `kind`: that reads as a tag/discriminator
 *   here, which this field is not.)
 * - `id`: the logical id the write targets.
 */
interface ResourceDescription {
  readonly label: string
  readonly id: string
}

export type { ResourceDescription }
