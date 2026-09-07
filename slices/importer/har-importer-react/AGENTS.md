# AGENTS.md — slices/importer/har-importer-react

The **HAR format's UI** for the importer slice: the (no-op) `HarSettingsPicker`
and the interactive per-URL `ReviewBody` the shell mounts inside its preview.
Presentation and interaction only — a view over `importer-fundamentals`' pure
`Review` model and `har-importer-core`'s descriptor. Nothing here decodes a HAR,
recognizes traffic, or writes resources; it drives the selection state the shell
decodes on confirm.

## Shape

- `src/review-body.tsx` — **`ReviewBody`**, the interactive per-URL review of one
  file's responses. It recognizes the responses against the pool
  (`Review.recognize`) and renders a per-URL list, grouped by URL in first-seen
  order:
  - **Whole-import kind toggles**, grouped by source: each of the descriptor's
    `sources` renders its name and detail (`display.title` / `display.description`)
    over a checkbox per kind. Each checkbox is labelled by the kind's `name` with
    its conventional `ResponseKind` suffix stripped (`PrescriptionResponseKind` →
    `Prescription`); the full `name` stays the selection key. Un-checking a kind
    disables it everywhere at once and every response re-derives its pick from what
    remains. A kind that recognizes nothing in _this_ file is shown disabled and
    reads as unchecked (toggling it would do nothing; its underlying selection
    state is untouched). Recognition runs against the sources' flattened kinds.
  - **A per-response picker** (`ResponsePicker`) — a static label when one kind
    matched, a `<select>` only on a genuine cross-source overlap, defaulting to
    the top-specificity candidate. A response whose every matching kind is toggled
    off shows an "excluded" label.
  - **A collapsible no-match section** (`<details>`) folds away the responses no
    kind claimed (the browser noise around the FHIR traffic).
  - **A per-resource include row** under each recognised response, one row per
    parsed resource — its `resourceType`, a one-line summary from
    `describeResource`, an include checkbox, and an **Edit** button that opens
    the inline JSON editor (`ResourceEditor`) for the row's resource — plus a
    per-type tally ("14 MedicationRequest, 2 excluded") above the URL list. A
    `duplicate` response renders the "Duplicate of X — not written" note in
    place of the picker, since a duplicate is never routed to a kind. A row
    whose resource has been edited shows an "Edited" chip and a **Revert**
    button beside the Edit; the summary line reflects the edited value, not
    the parsed original.
  - **Controlled** — the shell owns the `Review.Selection` per file and passes
    it in as `selection`, alongside the shell-computed `previews`; every
    toggle or override calls `onChange` with the next selection. The body
    holds no selection state of its own, so a re-render always renders the
    canonical shell state.
- `src/resource-editor.tsx` — **`ResourceEditor`**, the inline JSON editor a
  row opens on demand. A `react-tundraish` `Dialog` over a plain `<textarea>`
  of the pretty-printed resource. **Keep** parses the text, decodes through
  `Schema.decodeUnknown(FhirResourceSchema)` (`fhir-r4/resources`), and
  refuses the edit unless it parses and preserves `resourceType` / `id` (an
  id change would break every reference and the provenance link the confirm
  stamps); the failure — an `InvalidJsonError`, a `ParseError`, or an
  `ImmutableFieldChangedError` — surfaces through `ErrorBanner`, whose
  built-in Effect Schema tree renderer prints the reason. A kept edit calls
  the review's `Review.edit` through the ReviewBody; the dialog's own
  textarea state does not leak into the pure selection.
- `src/settings-picker.tsx` — **`HarSettingsPicker`** and the generic
  `SettingsPickerProps<TSettings>`. A no-op today (HAR has no settings): renders a
  hint, never calls `onChange`. It exists so the shell's registry has all three
  parts for HAR — the seam a format with real settings fills in.

## Layering

An adapter: depends on `importer-fundamentals` (`Review`), `har-importer-core`
(`HarSettings`), `http-extraction-fundamentals` (the `Extraction` /
`HttpResponseKind` / `SourceDescriptor` types the props carry), `effect`, and
`react`. Never imports
`importer-react` (the shell depends on this, not the reverse) or
`slices/collector`. Mirrors the collector slice's `ConfigFormProps` shape with
`SettingsPickerProps`.

## Guardrails

- **View over pure transitions, never its own logic.** Recognition, the default
  pick, the enabled-kind filter, and choose-then-persist all live in
  `importer-fundamentals`' `Review`; this package renders them. A behaviour that
  belongs to _what_ gets written (not how it looks) goes in `Review`, so the shell
  and the view can never disagree.
- **Selection state is the shell's, and this body is controlled.** The shell
  holds the canonical `Selection` per file and passes it in as `selection`;
  every toggle calls `onChange` with the next value. The body holds no
  selection state of its own — don't reintroduce one, or the shell and the
  view can disagree.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [importer-fundamentals AGENTS.md](../importer-fundamentals/AGENTS.md) — the pure
  `Review` model this package renders.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the descriptor
  whose `sources` this review recognizes against.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that mounts
  this `ReviewBody` per file, under one confirm.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
