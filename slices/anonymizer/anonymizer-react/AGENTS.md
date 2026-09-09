# AGENTS.md — slices/anonymizer/anonymizer-react

The **anonymizer shell**: the `AnonymizerScreen` a host app mounts — one local
picker, best-effort identification of the picked file against the closed format
registry, and the routed format panel. Client-side end to end: identify,
decode, review, blob download. **Issues no writes** and speaks to no server.

## Shape

- `src/registry.tsx` — the **closed format registry**: an ordered
  `readonly BoundFormat[]` literal, each entry minted by `bind(descriptor,
Panel)`. The pairing is a closure, not a lookup — `bind` takes a descriptor
  and a panel over the _same_ `T` and returns a `BoundFormat` whose
  `decodeToPanel` runs the decode and hands the value straight to the panel,
  so `T` never escapes and the shell routes heterogeneous formats without a
  cast. Registry order is identification priority: crisp magic-byte tests
  (a future PDF's `%PDF-`) go ahead of looser syntactic ones (HAR's JSON
  sniff). The HAR entry imports `harDescriptor` from `har-anonymizer-core`.
- `src/local-file-picker.tsx` — **`LocalFilePicker`**, the format-blind
  drop-zone-as-button and its hidden single-file input. Reads bytes, validates
  nothing; which format claims them is the screen's routing decision.
- `src/anonymizer-screen.tsx` — **`AnonymizerScreen`**. Owns the pick state
  and the decode lifecycle: identify via the fundamentals' `identify`
  (first claiming format wins), decode **once per picked identity** through
  `decodeToPanel` (async — a format's decode may be), render the resulting
  element, whose closure over the decoded value is the stable rebuild identity
  the HAR panel's traps require. Unclaimed file → the generic alert; failed
  decode → the format's own `DecodeFailure` sentence.

## The serverSource slot

`AnonymizerScreen` takes an optional
`serverSource?: ComponentType<{ readonly onPick: (file: PickedFile) => void }>`,
rendered below the local picker. It is the one seam a host uses to offer picks
the shell cannot — the Importer web app passes a `ServerSource` component from
`importer-react` through it. The component receives the same `onPick` callback
the local picker uses; whatever fetching or auth that took is the host's
business, which is what keeps this package free of any client, query, or router
dependency.

## Layering

The slice's shell. Depends on `anonymizer-fundamentals` (the contract and
routing helpers), `har-anonymizer-core` (the HAR descriptor), `har-anonymizer-react`
(the HAR panel), `effect`, `react`, `react-tundraish`. Never imports
`importer-react`, `web-trace-react`, or a FHIR client.

## Traps

- **Decode once per picked identity, asynchronously.** The `useEffect` decode
  holds a `cancelled` flag so a stale decode cannot clobber a newer pick. The
  decoded panel element is state, not a render-time computation — recomputing
  per render would rebuild the panel's preview on every keystroke.
- **`accept` is a hint, `detect` is the decision.** The OS dialog's filter can
  be bypassed (drop, "All files"); every path into the screen goes through
  `identify`.
- **A new format registers via `bind`, nothing else.** A registration whose
  panel disagrees with its descriptor's decoded type fails to compile; adding
  a format never touches the screen.

## Testing

`registry.test.ts` — the HAR descriptor's detect (extension property over
arbitrary bytes, JSON sniff, PDF negative) and decode (real archive →
entries; non-HAR JSON → `HAR_PARSE_ERROR`). `anonymizer-screen.test.tsx` —
the flow end to end over the real picker → registry → panel path: local pick
reaches the download surface, unclaimed and undecodable files surface their
alerts, the `serverSource` slot routes like a local pick, `Pick another`
returns to the sources.

## References

- [slices/anonymizer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [anonymizer-fundamentals AGENTS.md](../anonymizer-fundamentals/AGENTS.md) —
  the contract and routing helpers.
- [har-anonymizer-react AGENTS.md](../har-anonymizer-react/AGENTS.md) — the
  HAR panel this shell mounts.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
