/**
 * One resource a persist sink could not write, surfaced as data rather than an
 * error — the importer's structural echo of the write sink's own failure record.
 *
 * @remarks
 * A {@link FileImporterDescriptor}'s `persist` returns these on a `never` error
 * channel, so one bad write never stops the rest of a confirmed import. The
 * shape is declared here — this package sits below the concrete sinks and cannot
 * name them — and is checked **structurally** at each binding's seam, mirroring
 * how `collector-fundamentals` declares its own `PersistFailure` against
 * `fhir-r4`'s `ResourceWriteFailure`. A binding hands its sink's failures
 * straight back and a drift is a compile error at the binding, not a silent
 * divergence here.
 */
interface PersistFailure {
  /** The failed resource's display identity — its type/label and logical id. */
  readonly failed: { readonly label: string; readonly id: string }
  /** The underlying cause the sink reported, opaque to this package. */
  readonly cause: unknown
}

export type { PersistFailure }
