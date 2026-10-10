# AGENTS.md — apps/importer

The **Importer**: a SMART-on-FHIR app that turns a file the user picked into
FHIR resources on their server, reviewed first and written only on an explicit
confirm, beside an anonymizer that turns a capture or a document into a
share-safe file. The app itself is
[`importer-web`](./importer-web/AGENTS.md), published at
<https://wildflowerhealth.io/importer/>; the packages beside it are the ones
only it uses.

The importer's design — its package roles, layering and guardrails — is
[slices/importer/AGENTS.md](../../slices/importer/AGENTS.md). That slice keeps
the fundamentals and the format bindings, because the Synthetic Data Loader
proves its generators through them too; the rest of the flow lives here.

## Packages

- [`importer-web`](./importer-web/AGENTS.md) — the app: `ImporterScreen` and
  `AnonymizerScreen` under one Import | Anonymize tabstrip, around a SMART
  shell. Its homescreen tile is `importer` (`importer-dev` in a debug build).
- [`importer-core-js`](./importer-core-js/AGENTS.md) — the pure core: the
  closed format registry and the batch machinery the shell drives.
- [`importer-react`](./importer-react/AGENTS.md) — the shell: the
  pick-review-confirm flow, the React half of the registry, and the sectioned
  review every format shares.
- [`har-importer-react`](./har-importer-react/AGENTS.md),
  [`lifelabs-pdf-importer-react`](./lifelabs-pdf-importer-react/AGENTS.md) and
  [`dicom-importer-react`](./dicom-importer-react/AGENTS.md) — each format's
  settings picker, over its binding in `slices/importer`.
- [`dicom-react`](./dicom-react/AGENTS.md) — browser-side DICOM rendering (the
  `DicomFilePreview` the DICOM review shows), from the `file-formats` slice;
  the `dicom` package it renders stays there, shared with the Synthetic Data
  Loader.
- [`anonymizer/`](./anonymizer/AGENTS.md) — the whole anonymizer: its
  fundamentals, shell, and the HAR and PDF engines and panels
  (`har-anonymizer-core-js`, `pdf-anonymizer-core-js`), nested as the group
  they came in.

## Rules

- **The app composes; the packages own the flow.** `importer-web` holds no
  importing or anonymizing logic, only the tabstrip, the SMART wiring and the
  one adapter the anonymizer's `serverSource` slot asks of a host.

## References

- [slices/importer/AGENTS.md](../../slices/importer/AGENTS.md) — the importer's roles and guardrails
- [apps/importer/anonymizer/AGENTS.md](./anonymizer/AGENTS.md) — the anonymizer's roles and limits
- [apps/AGENTS.md](../AGENTS.md) — product folders and the names a product takes
