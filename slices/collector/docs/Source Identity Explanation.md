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

It lives in `fhir-r4/identity` and is two 64-bit FNV-1a lanes over the three
components, concatenated. The lane itself is `kitchen-sink`'s `fnv1a64` — the
standard algorithm, pinned in `fnv1a.test.ts` against the published FNV test
vectors, so "it is the standard implementation" is a checked fact rather than a
claim. What stays in `fhir-r4/identity` is what is _not_ standard FNV: the second
lane's displaced offset basis, the 128-bit concatenation, and the `wf-`
rendering.

Properties that matter:

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

### The components are length-prefixed, not delimiter-joined

`joinIdComponents` renders the three components as `${length}:${value}`
concatenated — `1:a7:Patient3:abc` — rather than joining them on a separator.

A separator is only unambiguous if no component can contain it, which is a
precondition on every caller rather than a property of the function. The earlier
`\n` join had exactly that flaw: `('a', 'b\nc', 'x')` and `('a\nb', 'c', 'x')` both
spell `a\nb\nc\nx` and collided outright. Nothing on a production path could
reach it — `system` is a regex-validated root URL or a minted constant, and
`resourceType` is a union literal or the `[A-Za-z]+` capture from
`RELATIVE_REFERENCE` — but the function whose job is to make ids unambiguous
should not depend on its callers to be.

`joinIdComponents` is exported because a caller that has to fold more than one
value into a single `originalId` must fold it the same way rather than inventing
a separator. `web-trace`'s `(sessionId, requestId)` pair is the one such caller;
nesting is safe, since a joined component is delimited by its own length prefix.

**The function is persisted wire format.** Its output is the primary key a
resource is stored under, so changing the prime, either offset basis, the
component encoding, the field order, or the prefix orphans everything already
stored. `local-resource-id.test.ts` pins exact outputs so that change fails
loudly.

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

| Resource             | Rewritten fields                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Patient`            | `generalPractitioner[]`, `managingOrganization`, `link[].other`, `contact[].organization`                                                                                                                                                                                                                |
| `Observation`        | `subject`, `encounter`, `device`, `specimen`, `basedOn[]`, `derivedFrom[]`, `focus[]`, `hasMember[]`, `partOf[]`, `performer[]`, `note[].authorReference`                                                                                                                                                |
| `MedicationRequest`  | `subject`, `encounter`, `requester`, `performer`, `recorder`, `priorPrescription`, `reportedReference`, `medicationReference`, `supportingInformation[]`, `reasonReference[]`, `basedOn[]`, `insurance[]`, `detectedIssue[]`, `eventHistory[]`, `dispenseRequest.performer`, `note[].authorReference`    |
| `MedicationDispense` | `subject`, `context`, `location`, `destination`, `statusReasonReference`, `medicationReference`, `partOf[]`, `supportingInformation[]`, `authorizingPrescription[]`, `receiver[]`, `detectedIssue[]`, `eventHistory[]`, `performer[].actor`, `substitution.responsibleParty[]`, `note[].authorReference` |
| `DocumentReference`  | `subject`, `authenticator`, `custodian`, `author[]`, `relatesTo[].target`, `context.sourcePatientInfo`, `context.encounter[]`, `context.related[]`                                                                                                                                                       |
| `Binary`             | `securityContext`                                                                                                                                                                                                                                                                                        |

The list is explicit rather than a structural walk, so what gets rewritten is
readable and reviewable. `adopt-resource.test.ts` guards it from both sides:

- It diffs the _complement_ of this table on generated resources, so a field
  touched **outside** it fails.
- It walks each resource schema's own AST for every path that declares a
  `Reference`, and asserts that set is exactly the rewritten paths. So a
  `Reference` field missing from **both** the implementation and the table fails
  too — the case the complement diff structurally cannot see, because a field
  nobody rewrites is a field the complement asserts was left alone.

The second guard is not theoretical: it is what found `note[].authorReference`,
which a hand walk of the same six schemas had signed off as complete.
`Annotation.author[x]` is a `Reference` when it is not the `authorString`
variant, and it sits one level down inside an array.

The walk stops at every `Reference` (that is the find) and at every `Identifier`
(whose `assigner` is exempt wherever it is reached from), which is also what
breaks the `Reference` ⇄ `Identifier` cycle. `extension`, `modifierExtension` and
`contained` are pruned as exempt subtrees; `Extension` is recursive, so
descending would not terminate anyway.

### Never touched

`contained` (raw passthrough JSON — a decoded `Identifier` injected there writes
`null`s onto the wire), `extension` / `modifierExtension` including any
`valueReference` inside them, `meta.source`, `Identifier.assigner`,
`groupIdentifier`, and `Attachment.url`.

`meta.source` is not a rewrite site because at adoption time it holds a
source-system URI, and the provenance hook overwrites it with a local trace
reference immediately afterwards — rewriting it earlier is dead work.

## Where a collector states its source

Adoption is **one option-less per-kind combinator**, `adoptUnderRecognizedRoot`
(in `fhir-r4/identity`). It wraps a single response kind, replacing its `parse`
with one that adopts the parse output under the identity **the kind's own
`tryRecognize` mints for the response's URL** — read verbatim from
`entity.tryRecognize(response.url).source`, with no source passed in. Each kind
constructs its own identity, so recognition and the namespace a resource keys
under are the one decision:

- **FHIR** (`fhir-r4-source`) — `tryRecognize` returns `source: { system: root,
baseUrl: root }`, the root captured by the kind's own fused `UrlMatch`. So a
  resource keys under the root of the URL it arrived on.
- **Rexall / Shoppers** — `tryRecognize` stays URL-gated but mints a constant
  `source: { system: SID }` (`REXALL_CAREBOOK_SYSTEM` /
  `SHOPPERS_DRUGMART_SYSTEM`, hardcoded in `config.ts`), no `baseUrl` because
  references are relative.
- **web-trace** — recognizes but mints **no** `source`, and is not adopted at
  all (see [below](#web-trace-mints-its-own-ids-at-its-codec)).

This unifies what used to be two wrappers doing the same job with the identity
sourced differently — a live `adoptSourceIdentity(constant)(plan)` that keyed
under a config constant, and an archive per-URL-root wrapper. There is now one
seam, and it is applied per kind at **module load**, not per plan: a collector
`.map`s its kind list through the combinator once, and `fhir-r4-source` exports
the result (`fhirR4ResponseKinds`) that both the live plan and the archive
importer consume. See the
[Adding a Collector How-To](./Adding%20a%20Collector%20How-To.md).

Consequences worth knowing:

- **No source parameter means no memo.** The old wrapper took the source as an
  argument and had to memoize one wrapped `parse` per `(source, entity)` so two
  plans from one config stayed `toEqual` (functions compare by identity). The
  identity now lives inside `tryRecognize`, so the combinator takes nothing to
  parameterize: a package applies it once and every plan built from any config
  shares the same frozen kind **by reference**. Deep-equal gets _easier_, and the
  memo — with its unbounded, user-driven key space — is gone.
- **An unrecognized URL fails as a `ParseError`.** A `parse` on a response whose
  `tryRecognize` returns `None` — or `Some` with no `source` — **fails** with a
  `ParseError` naming the real reason ("URL not recognized by this kind — cannot
  adopt an identity"), on the same channel a decode failure uses. It is the
  `web-trace` `digestFailureAsParseError` precedent: no channel widening, no
  defect, and `Extraction.run` reports it as an ordinary per-response
  `parseFailure`. In practice routing only ever hands a kind a URL it recognized,
  so this arm guards a misconfiguration, not a normal response.
- **`followUpSteps` receives adopted resources.** No entity defines one today,
  but a future generator that needs the source's id to build a source-server URL
  reads it back with `originalIdOf(source, resource)` rather than off
  `resource.id`.
- **The guard is per kind, and reads the whole `FhirResource` union.** Adoption
  widens: `adoptResource` is declared `FhirResource → FhirResource`, because
  TypeScript cannot correlate the variant matched with the branch taken. A
  combinator returning the kind's type unchanged would therefore be asserting
  something it does not deliver for a kind that declares a narrower element type.
  `adoptUnderRecognizedRoot` refuses such a kind, via a conditional on the
  parameter (`TEntity & EntityParsesEveryResource<TEntity>`) — the constraint
  alone cannot do it, since a narrower kind is a legitimate subtype by
  covariance. The fix is to widen the kind list to
  `HttpResponseKind<FhirResource>[]` **before** the `.map`: `fhir-r4-source`
  declares its input tuple that wide, and the credential collectors widen at
  module scope.

Note the variant preservation inside `adoptResource` is real but unchecked: each
`adoptX` maps a variant to itself **by construction**, and an `adoptX` that
returned a different variant would compile. That is stated on the function.

The tracker's ordering is `parse` → `followUpSteps` → `captureProvenance`, so the
provenance hook's `context.related` and `meta.source` are both built from adopted
ids with no changes to `capture-provenance.ts`.

### The three FHIR-family collectors

- **`fhir-r4-client-collector`** consumes `fhir-r4-source`'s
  `fhirR4ResponseKinds` directly — the same single pre-adopted definition the
  archive importer runs, so live and archive are now reference identity and
  cannot disagree. Each resource keys under `{ system: root, baseUrl: root }`
  where `root` is the URL-derived root of the response it arrived on. `baseUrl`
  makes a server that spells its own references absolutely rewrite them the same
  as relative ones.
- **`rexall-be-well-collector`** — `{ system: REXALL_CAREBOOK_SYSTEM }`, a
  Wildflower-minted `sid` URI declared in its `config.ts`; the kind list is
  widened to `HttpResponseKind<FhirResource>[]` and mapped through the combinator
  at module scope. No `baseUrl`: carebook references are relative.
- **`shoppers-drugmart-collector`** — `{ system: SHOPPERS_DRUGMART_SYSTEM }`,
  the same shape as Rexall (its kinds are already wide, so it maps without an
  extra widen). No `baseUrl`.

### Live FHIR keying is per-response now — the one accepted behavior change

Live FHIR keying moved from the **config-constant** `rootUrl` to each response's
**own URL root**. For an ordinary same-server capture the two coincide, so the
stored ids are byte-identical — pinned by `fhir-r4-client-collector`'s
`source-parity.test.ts`, whose surviving load-bearing property asserts
`tryRecognize(${config.rootUrl}/Patient/…).source.{system,baseUrl} ===
config.rootUrl` (the live==archive assertions above are reference-identity by
construction, so that property is the only real guard on the switch).

**Edge case:** a FHIR endpoint that redirects **cross-origin or cross-basepath**.
The sniffer pins `response.url` at `ResponseStart`, so the derived root becomes
the **redirect target**, where config-constant keying would have used
`config.rootUrl`. Resources from the two roots then key apart. This is accepted:
keying under a resource's own URL is what lets a capture that reached two servers
separate them with no inference, and a genuine cross-server reference is meant to
be absolute anyway (see [cross-server references
dangle](../../http-extraction/fhir-r4-source/AGENTS.md)).

## web-trace mints its own ids, at its codec

`web-trace-collector` does **not** call the combinator. A trace's id is minted by
`web-trace-core`'s `traceResourceId`, which is the single definition of that
encoding, so unification happened there instead:

```ts
traceResourceId({ sessionId, requestId }) = localResourceId(
  WEB_TRACE_SESSION_IDENTIFIER_SYSTEM,
  'DocumentReference',
  joinIdComponents([sessionId, requestId])
)
```

`(sessionId, requestId)` is still the identity of an exchange; only the rendering
changed, and both halves stay readable as `Identifier` entries the decode side
reads. This also fixes the illegal-id case by construction.

The pair goes through `joinIdComponents` rather than a `-` join for the reason
given above: both halves are arbitrary non-empty strings, so `('s-req', '77')`
and `('s', 'req-77')` would be the same exchange, one silently upserting over the
other.

**The derivation is not free, and the viewer must not pay it per render.** It is
two hash lanes over the encoded pair, ~600× the cost of the string concatenation
it replaced. `web-trace-react` keys its list rows and its open-exchange selection
with `exchangeKey` — the same encoded pair, unhashed — because a React `key` and
a selection key need identity within one list, not the resource id. Calling
`traceResourceId` in a render body costs ~24 ms per keystroke over a
thousand-exchange session.

**One id-minting site per resource kind.** Running a locally-minted resource
through `adoptUnderRecognizedRoot` as well would hash a hash, which is why
`web-trace`'s recording kind mints no `source` — it is recognized but never
adopted.

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
