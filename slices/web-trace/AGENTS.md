# AGENTS.md — slices/web-trace

Records a real browsing session against a target portal and turns it into
something a collector author can hand to an agent when designing a new
collector — without handing over the patient's data.

The asymmetry is the whole design: **store raw, view raw, anonymize only at the
export boundary.** Capture stays lossless, so a better redactor later can be
applied retroactively to sessions already recorded.

## Package roles

- **`web-trace-core`** — the pure layer, and the only package _in_ the slice:
  the vocabulary of a recorded session, and the translations built on it.
  See its [AGENTS.md](./web-trace-core/AGENTS.md).

The capture half lives outside this slice, in the collector slice where the
descriptor seam is: [`web-trace-collector`](../collector/web-trace-collector/AGENTS.md)
is the `*-client-collector` that records a hand-driven session and writes each
exchange through `web-trace-core`'s codec. It imports the encoding; it never
re-derives it.

## Why this slice exists

The FHIR encoding of a trace cannot live anywhere it already had a home:

- **not `collector-fundamentals`** — that package is deliberately FHIR-agnostic;
  nothing in it assumes FHIR-ish config.
- **not `browser-sniffer`** — that slice is deliberately FHIR-ignorant; no
  package in it knows about FHIR.

It is consumed by both a collector and a React app, so it has to sit below both.

## Guardrails

- **Redaction happens at the export boundary and nowhere else.** Capture is
  lossless and the viewer shows raw data — it is the user's own device and their
  own data. A change under `web-trace-core/src/pseudonymizer/` changes what
  leaves the device; read the
  [Redaction Explanation](./web-trace-core/docs/Redaction%20Explanation.md) first.
- **A trace never claims to know what the sniffer did not observe.** There is no
  request method, no request headers, and no request body; anything that needs
  one says it is missing rather than guessing.

## References

- [web-trace-core AGENTS.md](./web-trace-core/AGENTS.md) — module layout and traps.
- [browser-sniffer AGENTS.md](../browser-sniffer/AGENTS.md) — the upstream
  page-sniffing primitive a capture consumes, and the source of the
  known limitation that there is no request side.
- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
