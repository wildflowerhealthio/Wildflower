/**
 * Central catalog of OpenTelemetry span names and attribute keys for the
 * Collector hot path. Kept in one file — even for spans that fire from
 * other packages (the FHIR write-back lives in `collector-react`) — so the
 * naming philosophy stays coherent in a single place.
 *
 * Shape: `FeatureArea.Task.[Subtask].Span.{ Name, Attributes }`, with
 * attribute keys that recur across a feature lifted to a feature-level
 * `Attributes` namespace so they are defined once. Attribute values prefer
 * OpenTelemetry semantic conventions where one exists (`url.path`,
 * `error.type`, `http.request.method`); everything Collector-specific is
 * namespaced under `collector.*`.
 */

/** The timed walk through a scraping plan's link sequence. */
const Sniffing = {
  /** Attribute keys shared across the sniffing spans. */
  Attributes: {
    /** Zero-based index of the step within the link sequence. */
    StepIndex: 'collector.sniffing.step.index',
    /** Configured delay before the step dispatches, in milliseconds. */
    StepDelayMs: 'collector.sniffing.step.delay_ms',
    /**
     * Kind of the dispatched step: the action tag, with a `PageAction`'s
     * inner `kind` appended (`Open` / `PageAction:Click` / `PageAction:Fill`),
     * or `SniffingComplete` for the terminal dispatch. Cardinality is kept
     * low — the discriminator only, never per-selector detail.
     */
    LinkKind: 'collector.sniffing.link.kind',
    /** Configured URL-match wait cap for the step, in milliseconds. */
    UrlMatchTimeoutMs: 'collector.sniffing.step.url_match_timeout_ms',
  },
  /** Waiting out the inter-step delay before dispatching the next link. */
  Wait: {
    Span: { Name: 'collector.sniffing.wait' },
  },
  /**
   * Holding a step until a `PageLoaded` whose `url` matches the step's
   * `advanceWhen` pattern. The span closes when the wait cap
   * (`timeout`) elapses; a match interrupts the fiber before the span
   * closes, so a closed span means the step timed out and the run
   * aborted via `SniffingComplete`.
   */
  UrlMatchWait: {
    Span: { Name: 'collector.sniffing.url_match_wait' },
  },
  /** Dispatching a link (or the terminal `SniffingComplete`) to the sniffer. */
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

/** Turning a scraped HTTP response into resources and writing them back. */
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
  /** Writing one parsed resource back to its target, with retries. */
  Update: {
    Span: {
      Name: 'collector.importing.update',
      Attributes: {
        /** Total write attempts it took (1 = first try succeeded). */
        Attempts: 'collector.importing.update.attempts',
        /**
         * The resource's collector-agnostic kind label (for fhir-r4, its
         * `resourceType`), from the descriptor's `describeResource`. Kept
         * generic so the runner never names a collector's resource union.
         */
        Kind: 'collector.importing.resource.kind',
      },
    },
    /** A single FHIR PUT — modelled as a standard OTel HTTP client request. */
    Attempt: {
      Span: {
        Name: 'PUT',
        Attributes: {
          /** HTTP request method (OTel semconv). */
          Method: 'http.request.method',
        },
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
