/**
 * Central catalog of OpenTelemetry span names and attribute keys for the FHIR
 * R4 HTTP API hot path (search, read, write, `$everything`). Kept in one file
 * so the naming philosophy stays coherent in a single place.
 *
 * Shape mirrors the Collector catalog: `Task.[Subtask].Span.{ Name, Attributes }`,
 * with attribute keys that recur across a task lifted to a task-level
 * `Attributes` namespace (and resource-identity keys lifted to the top-level
 * `Resource` namespace) so they are defined once. Span names are lowercase,
 * dot-delimited, `snake_case` segments under a stable `fhir.*` namespace.
 * Attribute values prefer OpenTelemetry semantic conventions where one exists;
 * everything FHIR-specific is namespaced under `fhir.*`.
 */

/** Identity attributes shared by every FHIR resource span. */
const Resource = {
  Attributes: {
    /** FHIR resource type (`Patient` / `Observation` / `Binary`). */
    Type: 'fhir.resource.type',
    /** FHIR resource logical id. */
    Id: 'fhir.resource.id',
  },
} as const

/**
 * Reading a searchset: the two search endpoints, their shared core, the
 * store reads it issues, and the Bundle assembly.
 */
const Search = {
  /** Attribute keys shared across the search spans. */
  Attributes: {
    /** Page size applied to the underlying query. */
    Limit: 'fhir.search.limit',
    /** Row offset applied to the underlying query. */
    Offset: 'fhir.search.offset',
    /** Whether a `where` filter was built from the search params. */
    HasWhere: 'fhir.search.has_where',
    /** Whether the request carried an opaque `_pageToken` cursor. */
    HasPageToken: 'fhir.search.has_page_token',
    /** Client-requested `_count` (or the default) before paging is applied. */
    RequestedCount: 'fhir.search.requested_count',
  },
  /** `GET /:resourceType?<params>` — search via query string. */
  ByGet: { Span: { Name: 'fhir.search.by_get' } },
  /** `POST /:resourceType/_search` — search via form body. */
  ByPost: { Span: { Name: 'fhir.search.by_post' } },
  /** Shared search core: decode cursor, run query + count, build the Bundle. */
  Run: { Span: { Name: 'fhir.search.run' } },
  /** The paged `search$` store read. */
  Query: { Span: { Name: 'fhir.search.query' } },
  /** The `count$` store read for the searchset total. */
  Count: { Span: { Name: 'fhir.search.count' } },
  /** Assembling the FHIR searchset Bundle from the fetched rows. */
  Bundle: {
    Span: {
      Name: 'fhir.search.build_bundle',
      Attributes: {
        /** Number of resources placed in the Bundle. */
        ResourceCount: 'fhir.bundle.resource_count',
        /** Bundle `total` (full result count, not the page size). */
        Total: 'fhir.bundle.total',
        /** Number of pagination `link` entries on the Bundle. */
        LinkCount: 'fhir.bundle.link_count',
      },
    },
  },
} as const

/** Reading a single resource by id (`GET /:resourceType/{id}`). */
const Read = {
  /** The handler span. */
  Span: { Name: 'fhir.read' },
  /** The `getById$` store read backing it. */
  Query: { Span: { Name: 'fhir.read.query' } },
} as const

/** Creating or replacing a resource, then re-reading the persisted row. */
const Write = {
  /** `POST /:resourceType` — create. */
  Create: { Span: { Name: 'fhir.create' } },
  /** `PUT /:resourceType/{id}` — update (create-or-replace by id). */
  Update: { Span: { Name: 'fhir.update' } },
  /** Shared upsert-and-fetch core invoked by both create and update. */
  Upsert: { Span: { Name: 'fhir.upsert' } },
  /** The store commit of the upsert event. */
  Commit: { Span: { Name: 'fhir.upsert.commit' } },
  /** The `getById$` re-read issued after the commit. */
  Query: { Span: { Name: 'fhir.upsert.query' } },
} as const

/** `$everything`: the primary resource plus its related resources. */
const Everything = {
  /** Attribute keys specific to the `$everything` spans. */
  Attributes: {
    /** Cap on related resources returned (`_count`); `-1` when unbounded. */
    RelatedLimit: 'fhir.everything.related_limit',
  },
  /** `GET /:resourceType/{id}/$everything` — the handler span. */
  Span: { Name: 'fhir.everything' },
  /** The primary-resource `getById$` read. */
  Query: { Span: { Name: 'fhir.everything.query' } },
  /** Fetching resources related to the primary (e.g. a Patient's Observations). */
  GetRelated: { Span: { Name: 'fhir.everything.get_related' } },
} as const

export { Everything, Read, Resource, Search, Write }
