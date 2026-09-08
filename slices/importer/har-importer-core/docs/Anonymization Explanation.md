# Redaction Explanation

Why the pseudonymizer is shaped the way it is, and — more importantly — what it
does not protect. This is the privacy boundary of the Web Trace feature: capture
is lossless and the viewer shows raw data, so this module is the only thing
standing between a recorded browsing session and a collector author's inbox.

For the module layout and its traps, see
[web-trace-core AGENTS.md](../AGENTS.md).

## Shape-preserving, not a skeleton

A collector author reading a trace is trying to answer "what does this API
return, and how do I parse it". A structural skeleton — every value replaced by
`"<string>"` — answers none of that. So redaction replaces each value with
another value of the same _shape_: an ISO date stays an ISO date at the same
precision with the same timezone designator, a UUID stays a v4 UUID, a phone
number keeps its punctuation, a JWT stays a structurally valid JWT with the same
claim names and the same signing algorithm.

The shape classes are `iso8601`, `dotNetDate` (the `/Date(1779297900000-0400)/`
token .NET serializers emit — the literal and the offset stay, the millis move),
`jwt`, `uuid`, `email`, `currency`, `postalCode`, `phone`, `epochMillis`,
`numericId`, `alphanumericId`, and a `freeText` fallback. The fallback is what makes the module safe by default: an
unrecognized value is still pseudonymized, just with the least
structure-preserving generator. Nothing reaches an export unredacted because its
shape went unrecognized.

## Salt per export, not per session

The salt is minted once per export and never reused. Within one export the
mapping is stable, so if response A's `pid` equals response B's `patientId` they
are still equal after redaction — and that correspondence is exactly what tells a
collector author the two endpoints share a key. Across exports the mapping is
independent, so two exports of the same session cannot be linked back together.

The mapping is not only a keyed hash. Each export keeps a value→pseudonym table,
and a candidate pseudonym is rejected and re-derived unless it differs from its
original, re-detects to the same shape class, and has not already been handed to
a different original. That loop is what makes two of the guarantees true by
construction rather than probabilistically:

- no value survives as itself, even a short one;
- two different originals never collapse onto one pseudonym.

It also means a shape with a small space can genuinely run out — sixteen distinct
one-digit numbers cannot all get distinct one-digit fakes. That raises
`PseudonymSpaceExhausted` rather than silently colliding or silently widening the
value. Raising the enum threshold or adding a per-path verbatim override is the
fix.

One exception, on the `freeText` fallback shape: a value with no digits or
letters — `*/*`, `---`, `:::`, `.` — carries nothing the mapper can rewrite
(`mapCharClasses` only substitutes `[A-Za-z0-9]`, everything else is preserved
as structure), so every candidate is byte-identical to the original and the
`candidate !== original` check would reject the full 64 attempts. The redactor
passes those values through unchanged: there is no PHI to hide behind a
pseudonym when the whole string is punctuation, and failing an anonymize over
an `Accept: */*` header is worse than admitting that a `*/*` was there.

## Two carve-outs, not one

Pure pseudonymization destroys two different things that are not PHI: the short
codes an `HttpResponseKind` branches on, and the URIs that say what those codes
_mean_. They are recognised by separate rules, decided independently, and
switched independently.

|                | admits                                     | gated on                                  | counted?          |
| -------------- | ------------------------------------------ | ----------------------------------------- | ----------------- |
| Enum carve-out | `active`, `mg`, `entered-in-error`         | `isCodeToken`                             | yes, threshold 12 |
| Namespace URIs | `http://…/fhir/coding/medication-din-code` | `isNamespaceUri` — trusted host, or shape | no                |

The URI rule is tested first. A URI is never a code token, so a hidden `system`
field would otherwise always report `notCode` — pointing the reviewer at a
threshold that cannot bring it back, instead of at the switch that can.

## The enum carve-out

Pure pseudonymization turns `"status": "active"` into noise. Status codes and
unit enums are not PHI, and they are precisely what an `HttpResponseKind`
branches on. So a path can export verbatim — but it has to clear **two**
independent bars, and the order matters.

### Shape first, count second

A value is eligible only if it looks like a controlled-vocabulary code:
letters, hyphens, and underscores, no digits, no spaces, at most 64 characters
(`isCodeToken`). Every distinct value the path took has to qualify; one that
does not disqualifies the path, because the carve-out is per path and exporting
the rest verbatim would export that one too.

**Counting alone was not enough, and assuming it was let PHI out.** The
threshold asks how many distinct values a path takes. In a trace of one
patient's session, that patient's email, birth date, and postal code each take
exactly _one_ value at their path — comfortably under any threshold — so a
count-only rule exported all three as captured. Low cardinality is what PHI
looks like in a single-patient trace, not what an enum looks like.

The shape bar is an **allowlist**, deliberately: the carve-out has to admit only
what it can positively recognise, because everything it fails to exclude leaves
the device. It excludes every identifying class `detectShape` knows by
construction — an email has `@`, a date and a postal code have digits, a name
has a space — so the two rules cannot disagree.

Only then does the count apply: a qualifying path whose distinct values number
at most the threshold (default 12) exports verbatim.

### What this still does not solve

A name that is a single lowercase word — `ada`, `boston` — is indistinguishable
from a code by shape, and at a low-cardinality path it still exports verbatim.
No reliable syntactic rule separates the two. Two things bound the damage: the
export preview lists every carved-out path with a sample of what it holds, so a
reviewer can override one; and the carve-out is **off by default** in the export
UI, so the safe behaviour is what happens when nobody touches a control.

## The namespace-URI carve-out

FHIR spends URIs on two jobs that look alike and are not. `Coding.system`,
`Identifier.system`, and `Extension.url` hold URIs that name a _schema_ —
`http://schema.carebook.com/v1/fhir/coding/medication-din-code` is the label
that tells a collector author what the code beside it is. `Bundle.link.url`
holds a URI that addresses a _record_, patient id in the query string included.
Pseudonymizing the first destroys the only thing that made the payload legible;
exporting the second is a leak.

They are separated by the value's shape, never by the field's name. A field
name is a promise the server makes, and a `system` holding
`http://host/Patient/8a3f2b1c` would export a record URL verbatim on the
strength of that promise. A value qualifies one of two ways: its **host** is
trusted, or its **shape** reads as a namespace.

### The host allowlist

`TERMINOLOGY_HOSTS` names hosts that publish vocabulary. A URI on one of them
is admitted whatever its shape, because every shape rule below exists to tell a
namespace from a record URL and the host has already answered that. It answers
it better, too: `http://terminology.hl7.org/CodeSystem/v2-0203` is a real
system that the shape rules reject, because `0203` is a digit run they cannot
distinguish from a record id.

A trusted host skips **every** structural check, query string included. That is
the deliberate cost: `https://terminology.hl7.org/ValueSet/$expand?filter=ada`
would export as captured. It is acceptable because a published registry serves
no records, so a parameter on one cannot carry a patient.

The list holds two kinds of entry and they are not equally safe:

- **Standards bodies and public registries** — `hl7.org`, `terminology.hl7.org`,
  `loinc.org`, `snomed.info`, `unitsofmeasure.org`, `dicom.nema.org`,
  `nlm.nih.gov`, `www.ama-assn.org`, `www.whocc.no`,
  `fhir.infoway-inforoute.ca`. These cannot serve a record URL, because serving
  records is not something they do.
- **Portal schema hosts** — `schema.carebook.com`, `schemas.carebook.com`.
  These are trusted because someone read a capture from that portal and
  concluded it publishes schemas at that hostname. Add one only after looking.
  If a portal ever served a record URL from its schema host, this would export
  it.

Matching is **exact**, on the hostname. `hl7.org.example.com` is a different
host, not a suffix of a trusted one, and a new subdomain of a trusted host
needs its own entry rather than arriving on its own — which is why
`schema.carebook.com` and `schemas.carebook.com` are both listed.

### The shape rule

For every other host, `isNamespaceUri` admits a value only when it is:

- `urn:oid:` naming a registered arc, or `http` / `https`;
- carrying no query, no fragment, and no credentials;
- built of path segments that are code tokens, with version tokens (`v1`, `R4`,
  `stu3`) the sole digit-bearing exception;
- at most 256 characters.

The version exception is an allowlist of prefixes rather than "letters then
digits", because the looser rule also admits `w8`, `h1`, and `wqx0` — the
opaque tenant and environment segments a per-record URL is built from.

An untrusted host is otherwise unconstrained: it is an organization-level fact
the export already discloses for every exchange, so rejecting hosts that carry
a digit would reject legitimate systems and buy nothing.

### Not counted, and that is the point

A namespace URI is exempt from the distinct-value threshold. The threshold
exists because low cardinality is what PHI looks like in a single-patient
trace — but that reasoning is about values that describe a _person_. A URI that
names a schema describes the system, so its cardinality carries no signal in
either direction. A portal with forty private extensions has forty keys, not
forty secrets. The real capture that motivated this had eighteen distinct
`extension[].url` values against a default threshold of twelve; counting them
would have hidden the field for no reason anyone could act on.

### What this still does not solve

On an untrusted host, a segment whose digits are not a version is rejected —
`https://portal.example.org/CodeSystem/v2-0203` stays hidden. Admitting a bare
digit run would readmit every numeric id, which is a worse trade. Two answers
exist and they are ordered: add the host to `TERMINOLOGY_HOSTS` if it is a
registry or a schema host someone has read a capture from, and otherwise use
the per-path override the code carve-out's residue uses.

This is why redaction is two steps. `buildRedactionPolicy` walks the session and
counts; `redactExchange` rewrites one exchange against the result. The split lets
the viewer render the decisions it made, lets a reviewer override one path, and
lets a single exchange be re-redacted after an override without recounting.

Paths are keyed so that counting is meaningful: body leaves by JSON path with
array indices collapsed (`body:$.entry[].resource.status`), query values by
parameter name, headers by lowercased name, and URL segments by
host-plus-path-template rather than by literal URL — counting per literal URL
would give every record its own path and defeat the carve-out entirely.

## What is structure and what is data

Preserved verbatim, because it is format rather than content: JSON keys, nesting,
array cardinality, HTTP status codes and status text, header _names_, content
types, URL scheme and host, the URL path's shape, `null`, booleans, and empty
strings. A skipped body's recorded size is kept too — it is a fact about what was
dropped. A walked JSON body's size is recomputed from the rewritten bytes, since
the pseudonyms are not the same length as what they replace.

Preserved when the reviewer asks for it: short controlled-vocabulary codes, and
the namespace URIs that name what those codes mean. Both are off by default in
the export UI.

Pseudonymized, because it identifies: every JSON leaf value, header values,
cookie values, query values, the body digest, and URL path segments that look
like identifiers. A path segment "looks like an identifier" when it carries a
digit or matches a recognized identifier shape — so `patients` and `v2` survive
as the route structure a collector author needs, while `10432` and
`8a3f…` do not.

## Limits — read these before trusting a redacted export

- **Only JSON bodies are walked.** An HTML, XML, or binary body is dropped at the
  boundary and recorded as a `SkippedBody` with its size, because this module
  cannot pseudonymize a format it cannot parse and shipping it unredacted is not
  an option. A trace of an HTML-heavy portal loses most of its body content on
  export.
- **The body digest is pseudonymized, not preserved.** A real digest of a small
  body lets a recipient confirm a guessed body, so the exported hash is an
  opaque same-shaped value, not a checksum. Do not treat it as one.
- **Response timings and status survive, and so does a skipped body's size.**
  They are facts about the response that a collector author needs, and they
  identify nothing on their own — but they are a side channel in the strict sense.
- **The host survives, and so do the TLD of an email and the `iss`/`aud` of a
  JWT.** These describe the _system_, which is the point of the export. They do
  say which portal was visited.
- **Very short values are pseudonymized but weakly.** A two-character value has a
  small pseudonym space; the table guarantees it changes and stays distinct, but
  not that it is unguessable.
- **This is pseudonymization, not anonymization.** Structure, cardinality, and
  the join relationships between endpoints all survive by design. A redacted
  trace of a single-patient session still describes that session's shape.

## Testing

The five properties the boundary rests on are in
`src/pseudonymizer/redact.test.ts`: no original leaf survives as a substring of
the output, shape class is preserved, one salt is injective in both directions,
two salts are disjoint, and keys/cardinality/URL structure are unchanged.

Each carve-out then adds the property that bounds what it exposes: no verbatim
path carries a digit, a space, or punctuation when only codes are on; nothing
but a namespace URI survives when only URIs are on. Both are stated over the
whole generated corpus, which is why `test-helpers.ts` generates namespace URIs
at `system` and `url` keys — a corpus without them would let either property
pass without ever reaching the rule it is about.

The substring property is asserted for leaf values of eight characters or more.
Shorter values will turn up inside a long fake by chance, and asserting otherwise
would be asserting something false; that they still change and stay distinct is
covered by the injectivity property, which applies at every length.

See [Property Testing Reference](../../../../docs/Testing/Property%20Testing%20Reference.md)
for the conventions those tests follow.
