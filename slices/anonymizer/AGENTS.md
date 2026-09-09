# AGENTS.md — slices/anonymizer

The **anonymizer**: the user-facing offering that turns a real capture or
document into a share-safe artifact — reviewed on-device, downloaded as a file,
and never sent anywhere. Everything in this slice is read-only and local: no
network egress, no FHIR writes, no services beyond what a decode needs. The
slice mirrors the importer slice's shape: a format-agnostic **fundamentals**
package under per-format **bindings** (core + React) under a **shell** that
best-effort identifies the picked file and routes it to the right panel.

HAR is the format today; PDF (a LifeLabs lab report exported as anonymized
positioned-text JSON) joins as a sibling binding. See
[Anonymization Explanation](./docs/Anonymization%20Explanation.md) for the
pseudonymizer's design and — more importantly — its stated limits.

## Package roles

Each package's own AGENTS.md is the authority on its shape; the roles:

- **`anonymizer-fundamentals`** (format-agnostic) — `PickedFile` (name +
  bytes), the `AnonymizerFormatDescriptor` contract (accept / detect / decode),
  and the structural `DecodeFailure`.
- **`har-anonymizer-core`** (the HAR engine) — the shape-preserving
  pseudonymizer: the redaction policy (enum carve-out, namespace URIs,
  per-path overrides), the HMAC-keyed value→pseudonym table, the leaf
  walkers, and `harDescriptor` (the `AnonymizerFormatDescriptor` binding for
  HAR: detect by extension or JSON sniff, decode through
  `HttpArchive.LogFromHarJson`).
- **`har-anonymizer-react`** (the HAR panel) — `AnonymizePanel`, the surface
  that reviews the pseudonymizer's decisions over a parsed `HttpArchive.Log`
  and downloads an anonymized `.har`. Presentation and interaction only.
- **`anonymizer-react`** (the shell) — `AnonymizerScreen`: one local picker,
  file identification against the closed `format → { descriptor, Panel }`
  registry, and an optional `serverSource` slot a host fills to offer
  server-held archives (the shell itself never talks to a server).

A host mounts `AnonymizerScreen` directly — the Importer web app pairs it with
`ImporterScreen` under one Import | Anonymize tabstrip. `web-trace-react`
mounts `AnonymizePanel` directly inside its recordings surface.

## Layering

- **Fundamentals and cores are pure** — no DOM, no platform imports.
- **Accepted external seams**: `har-anonymizer-core` imports
  `har-importer-core/har` (the `HttpArchive` projection) and `web-trace-core`
  (`TraceExchange`) — the HAR _format_ stays owned by the importer slice; this
  slice owns only the redaction of it. Nothing here imports `importer-react`
  or `slices/collector`.
- **The registry is closed and compile-time.** `anonymizer-react`'s registry is
  a literal `as const`; a format missing a part fails to compile.
- **Nothing here writes.** No package in this slice may depend on a FHIR write
  client; the only outputs are blobs the user downloads.

## References

- [Anonymization Explanation](./docs/Anonymization%20Explanation.md) — the
  pseudonymizer's design and limits. Read before changing redaction behavior.
- [slices/importer/AGENTS.md](../importer/AGENTS.md) — the sibling slice whose
  shape this one mirrors, and the owner of the HAR format seam.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
