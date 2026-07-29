# Source Identity Explanation

Why an imported resource is not stored under the id its source gave it, and what
replaces that id.

## Why a source's id is not the store's id

The on-device FHIR store is keyed by resource id: `persistResources` writes each
resource with `PUT /fhir-r4/{Type}/{id}`, so the id _is_ the upsert key. A
collector that wrote the id its source uses would make that key mean whatever
each source means by it:

- Two servers that both number their first patient `1` clobber each other.
- Rexall's carebook dialect gives a `MedicationRequest` and its
  `MedicationDispense` the **same** id, so anything keying on id alone collapses
  the pair.
- A source id is not required to be a legal FHIR id. `web-trace`'s session label
  is an arbitrary string, and one carrying a space yields an id no conformant
  server accepts.
- The source's own id has nowhere structured to live, so "what does the server
  call this?" is unanswerable.
- Cross-resource references resolve only where a source happens to agree with
  itself: an `Observation.subject` of `Patient/abc` lands because the Patient
  entity also writes `abc`.

## The derivation

Every imported resource is keyed under a **derived local id**:

```text
localResourceId(sourceSystem, resourceType, originalId) → "wf-<32 lowercase hex>"
```

It lives in `fhir-r4/identity` and is two 64-bit FNV-1a lanes over
`${system}\n${resourceType}\n${originalId}`, concatenated. Properties that
matter:

- **Synchronous.** Entity parses run under the collector's sync runner; Web
  Crypto's digest is async and would have forced the whole parse path to change.
- **Non-cryptographic is fine.** Nothing here defends against an adversary
  choosing colliding ids; the derivation only has to be stable and
  collision-resistant against ordinary source ids.
- **Always a legal FHIR id.** `wf-` plus 32 hex is 35 characters of
  `[A-Za-z0-9\-.]`, whatever went in.
- **The resource type is an input**, which is what separates Rexall's
  request/dispense pair.
- **The source system is an input**, which is what keeps two servers apart.

The `wf-` prefix is fixed rather than per-source. Source attribution lives in the
identifier, not in the id.

**The function is persisted wire format.** Its output is the primary key a
resource is stored under, so changing the prime, either offset basis, the
separator, the field order, or the prefix orphans everything already stored.
`local-resource-id.test.ts` pins exact outputs so that change fails loudly.

## What adoption does to a resource

`adoptResource(source)` is the per-resource rewrite. Given a `SourceIdentity`
(`{ system, baseUrl? }`) it:

1. **Passes a null-id resource straight through.** There is no identity to adopt,
   and `upsertResource` cannot write one either.
2. **Derives the id** from `(system, resourceType, originalId)`.
3. **Prepends one `Identifier`** carrying the source's own id —
   `identifier[0] = { system: <source system>, value: <original id> }`. Every
   identifier the source already wrote is kept, behind it. There is deliberately
   no "already adopted?" guard: adoption runs exactly once per resource, at one
   choke point, so a source that publishes its own base URL as an identifier
   system yields a benign duplicate and nothing worse.
4. **Rewrites references** through the per-type field table below.

`Binary` is the exception to step 3: FHIR R4 gives it no `identifier` element, so
its original id survives only in the provenance trace. It is still adopted rather
than passed through, because a reference _to_ a Binary from a sibling resource
has to land on the same derived id. `originalIdOf` returns `null` for a Binary.

### The reference rule

For one `Reference`:

```text
reference.reference is null                              → unchanged
strip a leading `${baseUrl}/` when the source declares one
the remainder does not match `^[A-Za-z]+/[A-Za-z0-9\-.]{1,64}$`  → unchanged
otherwise → reference := `${Type}/${localResourceId(system, Type, id)}`
            identifier := the existing one, or the source's id
```

The grammar check is what leaves alone: `#fragment` contained references,
`urn:uuid:`, foreign absolute URLs, version-specific `Type/id/_history/v`, ids
carrying a space, and hyphenated pseudo-types like carebook's
`rexall-pharmacy-location/pharmacy-4821`.

Rewrites apply to **any** resource-type token, not only the six types the store
holds. The derivation is deterministic, so a `Practitioner/x` link resolves
retroactively if that type is ever imported from the same source, and dangles
exactly as it did before if it never is.

A pre-existing `Reference.identifier` is **kept**. The slot is 0..1 and carebook
already fills it with its own pharmacy id; the original `Type/id` stays
recoverable by resolving the rewritten reference and reading the target's
`identifier[0]`.

### Reference field table

| Resource             | Rewritten fields                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Patient`            | `generalPractitioner[]`, `managingOrganization`, `link[].other`, `contact[].organization`                                                                                                                                                                                      |
| `Observation`        | `subject`, `encounter`, `device`, `specimen`, `basedOn[]`, `derivedFrom[]`, `focus[]`, `hasMember[]`, `partOf[]`, `performer[]`                                                                                                                                                |
| `MedicationRequest`  | `subject`, `encounter`, `requester`, `performer`, `recorder`, `priorPrescription`, `reportedReference`, `medicationReference`, `supportingInformation[]`, `reasonReference[]`, `basedOn[]`, `insurance[]`, `detectedIssue[]`, `eventHistory[]`, `dispenseRequest.performer`    |
| `MedicationDispense` | `subject`, `context`, `location`, `destination`, `statusReasonReference`, `medicationReference`, `partOf[]`, `supportingInformation[]`, `authorizingPrescription[]`, `receiver[]`, `detectedIssue[]`, `eventHistory[]`, `performer[].actor`, `substitution.responsibleParty[]` |
| `DocumentReference`  | `subject`, `authenticator`, `custodian`, `author[]`, `relatesTo[].target`, `context.sourcePatientInfo`, `context.encounter[]`, `context.related[]`                                                                                                                             |
| `Binary`             | `securityContext`                                                                                                                                                                                                                                                              |

The list is explicit rather than a structural walk, so what gets rewritten is
readable and reviewable. `adopt-resource.test.ts` diffs the _complement_ of this
table on generated resources, so a field touched outside it fails.

### Never touched

`contained` (raw passthrough JSON — a decoded `Identifier` injected there writes
`null`s onto the wire), `extension` / `modifierExtension` including any
`valueReference` inside them, `meta.source`, `Identifier.assigner`,
`groupIdentifier`, and `Attachment.url`.

`meta.source` is not a rewrite site because at adoption time it holds a
source-system URI, and the provenance hook overwrites it with a local trace
reference immediately afterwards — rewriting it earlier is dead work.

## Where a collector states its source

`adoptSourceIdentity(source)` wraps a whole `ScrapingPlan`: it replaces each
entity's `parse` with one that adopts the parse output, and passes every other
plan field (`captureProvenance`, `stepSequence`, `firstPage`, timeouts) through by
reference. A collector's entire wiring is one line at the end of its plan factory
— see the [Adding a Collector How-To](./Adding%20a%20Collector%20How-To.md).

Two consequences worth knowing:

- **The wrapper is memoized per `(source, entity)`.** Plan factories are
  deterministic and per-collector suites deep-equal two plans built from one
  config; `toEqual` compares functions by identity, so a fresh closure per call
  would break every one of them.
- **`followUpSteps` receives adopted resources.** No entity defines one today,
  but a future generator that needs the source's id to build a source-server URL
  reads it back with `originalIdOf(source, resource)` rather than off
  `resource.id`.

The tracker's ordering is `parse` → `followUpSteps` → `captureProvenance`, so the
provenance hook's `context.related` and `meta.source` are both built from adopted
ids with no changes to `capture-provenance.ts`.

### The two production collectors

- **`fhir-r4-client-collector`** — `{ system: config.rootUrl, baseUrl: config.rootUrl }`.
  The system is the **configured** root, never a URL recovered from a response.
  `baseUrl` makes a server that spells its own references absolutely rewrite them
  the same as relative ones. The hash uses the raw configured string while the
  stored `Identifier.system` is `new URL(rootUrl)`, whose `.href` may re-add a
  trailing slash on a bare host — cosmetic, and irrelevant to the derivation.
- **`rexall-be-well-collector`** — `{ system: REXALL_CAREBOOK_SYSTEM }`, a
  Wildflower-minted `sid` URI declared in its `config.ts`. No `baseUrl`: carebook
  references are relative.

## web-trace mints its own ids, at its codec

`web-trace-collector` does **not** call the combinator. A trace's id is minted by
`web-trace-core`'s `traceResourceId`, which is the single definition of that
encoding, so unification happened there instead:

```ts
traceResourceId({ sessionId, requestId }) = localResourceId(
  WEB_TRACE_SESSION_IDENTIFIER_SYSTEM,
  'DocumentReference',
  `${sessionId}-${requestId}`
)
```

`(sessionId, requestId)` is still the identity of an exchange; only the rendering
changed, and both halves stay readable as `Identifier` entries the decode side
reads. This also fixes the illegal-id case by construction.

**One id-minting site per resource kind.** Running a locally-minted resource
through `adoptSourceIdentity` as well would hash a hash, so a plan that produces
traces must not be wrapped.

## One format, no guards

Every resource in the store is keyed by this derivation — there is no second id
format to recognize, so nothing reads or writes one. Adoption likewise runs
exactly once per resource, at the plan seam, so there is deliberately no
"already adopted?" guard: such a guard has to guess, and a source that publishes
its own base URL as an identifier system makes it guess wrong.

## References

- [Adding a Collector How-To](./Adding%20a%20Collector%20How-To.md) — the one step
  that states a collector's source system.
- [collector AGENTS.md](../AGENTS.md) — the plan/entity/descriptor vocabulary this
  builds on.
- [web-trace-core AGENTS.md](../../web-trace/web-trace-core/AGENTS.md) — the codec
  that mints trace ids.
