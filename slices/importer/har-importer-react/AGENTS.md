# AGENTS.md — slices/importer/har-importer-react

The **HAR format's UI** for the importer slice: the `HarSettingsPicker`, the
whole-import response-kind toggles the shell mounts with its per-format
settings form. Presentation and interaction only — a view over
`har-importer-core`'s `fhirSources` and `HarSettings`. Nothing here decodes a
HAR, recognizes traffic, or writes resources; the toggles edit a pre-decode
_setting_, and the shell re-decodes the batch's HAR files through the
descriptor when it changes.

The format has no review UI of its own. The interactive per-URL `ReviewBody`
this package used to own is gone: the shell's generalized sectioned review
(`importer-react`'s `PreviewPanel` — per-resource include/edit over the
descriptor's decoded sections) covers every format, and the HAR-specific
routing surface shrank to the kind toggles here. The per-response kind
override (`<select>` on a cross-source overlap) was dropped with it — routing
always takes the top-specificity enabled candidate.

## Shape

- `src/settings-picker.tsx` — **`HarSettingsPicker`**, a checkbox per
  registered kind, grouped by source (each source's `display.title` /
  `display.description` headings the group). Checkbox labels strip the
  conventional `ResponseKind` suffix (`PrescriptionResponseKind` →
  `Prescription`); the full name is the value stored. The toggles drive
  `HarSettings.disabledKinds` — kinds default to on, the settings hold only
  the explicit opt-outs — and every change reports up through
  `SettingsPickerProps.onChange` verbatim; the shell owns the settings.

## Layering

An adapter: depends on `har-importer-core` (`fhirSources`, `HarSettings`),
`importer-fundamentals` (`SettingsPickerProps`), and `react`. Never imports
`importer-react` (the shell depends on this, not the reverse) or
`slices/collector`.

## Guardrails

- **Settings, not review state.** A kind toggle is pre-decode input: the shell
  re-runs the descriptor's `decode` under the new settings, and the decode
  itself folds a disabled kind's responses into diagnostic notes. Don't grow a
  post-decode selection model here — that seam was deliberately removed.

## References

- [slices/importer AGENTS.md](../AGENTS.md) — the slice's package roles.
- [har-importer-core AGENTS.md](../har-importer-core/AGENTS.md) — the sources
  and settings this picker renders.
- [importer-react AGENTS.md](../importer-react/AGENTS.md) — the shell that
  mounts this picker in its per-format settings form.
- [Doc Comments Reference](../../../docs/Documentation/Doc%20Comments%20Reference.md)
  — TSDoc conventions the modules here follow.
