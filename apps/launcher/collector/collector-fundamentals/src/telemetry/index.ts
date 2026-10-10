/**
 * Central catalog of OpenTelemetry span names and attribute keys for the
 * Collector hot path. Kept in one file — including spans that fire from other
 * packages in this slice — so the naming philosophy stays coherent in a single
 * place.
 *
 * It names what this slice *emits*, and nothing else. The per-resource write a
 * descriptor's persist sink performs is `fhir-r4`'s, so it is named in
 * `fhir-r4/telemetry` (`Persist`) rather than restated here — see
 * {@link Importing}.
 *
 * Shape: `FeatureArea.Task.[Subtask].Span.{ Name, Attributes }`, with
 * attribute keys that recur across a feature lifted to a feature-level
 * `Attributes` namespace so they are defined once. Attribute values prefer
 * OpenTelemetry semantic conventions where one exists (`url.path`,
 * `error.type`, `http.request.method`); everything Collector-specific is
 * namespaced under `collector.*`.
 */

/** The breadth-first walk through a scraping plan's step queue. */
const Sniffing = {
  /** Attribute keys shared across the sniffing spans. */
  Attributes: {
    /** Configured duration of a `Delay` step being waited out, in milliseconds. */
    DelayMs: 'collector.sniffing.delay_ms',
    /**
     * Kind of the dispatched step: the action tag, with a `PageAction`'s
     * inner `kind` appended (`Open` / `PageAction:Click` / `PageAction:Fill`),
     * or `SniffingComplete` for the terminal dispatch. Cardinality is kept
     * low — the discriminator only, never per-selector detail.
     */
    LinkKind: 'collector.sniffing.link.kind',
    /** Configured URL-match wait cap for the step, in milliseconds. */
    UrlMatchTimeoutMs: 'collector.sniffing.step.url_match_timeout_ms',
    /** Configured user-dismiss wait cap for the step, in milliseconds. */
    UserDismissTimeoutMs: 'collector.sniffing.step.user_dismiss_timeout_ms',
    /** Configured plan-level drained-guard cap, in milliseconds. */
    DrainedGuardTimeoutMs: 'collector.sniffing.drained_guard_timeout_ms',
  },
  /** Waiting out an explicit `Delay` step before processing the next queue entry. */
  Wait: {
    Span: { Name: 'collector.sniffing.wait' },
  },
  /**
   * Holding on an `AwaitPageSettled` step until a settled `PageLoaded` whose
   * `url` matches the step's `pattern`. The span closes when the wait cap
   * (`timeout`) elapses; a match interrupts the fiber before the span
   * closes, so a closed span means the step timed out and the run
   * aborted via `SniffingComplete`.
   */
  UrlMatchWait: {
    Span: { Name: 'collector.sniffing.url_match_wait' },
  },
  /**
   * Holding on an `AwaitUserDismiss` step until the user closes the sniffer
   * webview. The span covers the wait itself: it ends normally when the wait cap
   * (`timeout`) elapses, and ends *interrupted* when a dismissal (or a dispose)
   * cancels the timer first — so it is the span's exit status, not its presence,
   * that says whether the user acted.
   */
  UserDismissWait: {
    Span: { Name: 'collector.sniffing.user_dismiss_wait' },
  },
  /**
   * The run's last-resort bound, armed whenever the step queue drains and
   * disarmed the moment it re-awakens or the run completes. It ends *normally*
   * only when the run failed to complete on its own — i.e. a sniffed request
   * never reached a terminal event — which escalates to
   * `abandonAllRequestSniffing`. A healthy run always ends this span
   * *interrupted*, so unlike the other waits, a closed span here is the anomaly
   * worth alerting on.
   */
  DrainedGuardWait: {
    Span: { Name: 'collector.sniffing.drained_guard_wait' },
  },
  /** Dispatching a navigation (or the terminal `SniffingComplete`) to the sniffer. */
  Dispatch: {
    Span: { Name: 'collector.sniffing.dispatch' },
  },
} as const

/** A foreign entity being scraped. */
const Entity = {
  Attributes: {
    /** The matched entity definition's stable name. */
    Name: 'collector.entity.entity.name',
    /** Decoded response body size in bytes (post base64-decode); OTel semconv. */
    Size: 'http.response.body.size',
    /** Request URL path (OTel semconv). */
    UrlPath: 'url.path',
  },

  Chunk: {
    Attributes: {
      /** Number of wire chunks buffered for the response. */
      ChunkCount: 'collector.entity.chunk.count',
    },
  },
} as const

/**
 * Turning a scraped HTTP response into resources and writing them back.
 *
 * @remarks
 * Only the parts this slice *emits* are named here. The per-resource write is
 * `fhir-r4`'s (`fhir.persist.write`, tagged `fhir.resource.type`, with each
 * retry attempt nested under it as a standard OTel `PUT` HTTP client span), so
 * it is named in that package's catalog — a descriptor's persist sink is
 * `fhir-r4`'s `persistResources`, not something a collector writes. `Importing`
 * is still its parent span, so a trace reads `collector.importing` →
 * `fhir.persist.write` → `PUT`.
 */
const Importing = {
  Span: {
    Name: 'collector.importing',
    Attributes: {
      /** Number of resources dispatched for update. */
      ResourceCount: 'collector.importing.resource.count',
    },
  },
  /** Decoding a completed response into the entity's resource array. */
  Parse: {
    Span: {
      Name: 'collector.importing.parse',
      Attributes: {
        /** Error class when the parse fails (OTel semconv); unset on success. */
        ErrorType: 'error.type',
      },
    },
  },
} as const

const Sync = {
  /** Attribute keys shared across the sync spans. */
  Attributes: {
    /** Sync span exit outcome: clean vs cancelled. */
    Outcome: 'collector.sync.outcome',
  },

  Span: {
    Name: 'collector.sync',
    Attributes: {},
  },
} as const

export { Entity, Importing, Sniffing, Sync }
