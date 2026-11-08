# AGENTS.md — apps/assistant/assistant-web

The Assistant, a SMART-on-FHIR app published to
<https://assistant.wildflowerhealth.io/> (package `assistant-web`), with an
`assistant-dev` row in debug builds. See [README.md](./README.md) for the boot
structure, the page and how to run it.

`apps/plots/plots-web` is the template: the same one HTML entry, relative
`base`, build into the package's own `dist/`, `SmartAppRoot` shell, and patient
choice.

## Rules

- **Compose; decide nothing.** The app owns only the SMART shell and the
  page's wiring; the patient is `smart-app-react`'s (`usePatientChoice`,
  `PatientPicker`, `PatientChoiceLine`).
- **The page is patient → body.** `App` settles on the patient — one patient,
  or All patients — and renders the body under it, keyed per choice, so a
  change of patient starts the body afresh. The body is `assistant-react`'s
  `AssistantChat`, given the connection's FHIR base, the patient, the
  granted scopes (`useGrantedScopes()`) and the SMART runtime's `runSmart`
  (`useRunSmart()`), which its tools read through: for one
  patient, once the `Patient` read `PatientChoiceLine` also makes has landed
  (`smart-app-react`'s `patientQuery`, the same cache entry), so the chat can
  state the name and birth date; for All patients, at once.
- **`config.ts` is the registration's one TypeScript home.** `ASSISTANT_SCOPE`
  and both client ids are read by `authorization-server-rust`'s `seeding.rs`
  test, which holds the seeded clients to them. The scope asks for everything;
  the grant, not the string, decides what the agent can do.

## Testing

- `app.test.tsx` stubs only the handshake. The patient reads are the real
  `fhir-r4-react/smart` ones over a stub client answering from a table of FHIR
  JSON by URL prefix. They cover the handshake's states and the patient as the
  page uses it — the launch's, the URL's, a pick, a change, and All patients;
  the picker, the line and the hook themselves are tested in
  `smart-app-react`.
- `app-root.test.tsx` — that `AppRoot` mounts the shared shell as the
  Assistant (the landing `h1` is `APP_DESCRIPTIONS.assistant.name`) and
  reports to its own Sentry project; the shell itself is tested in
  `smart-app-react`.
- `main.test.tsx` — the Pages 404 redirect is completed before anything reads
  the URL.

## References

- [apps/assistant/AGENTS.md](../AGENTS.md) — the product.
- [apps/plots/plots-web/README.md](../../plots/plots-web/README.md) — the template.
- [slices/smart-app-react/AGENTS.md](../../../slices/smart-app-react/AGENTS.md) —
  the shell and the patient choice.
- [apps/AGENTS.md](../../AGENTS.md) — the rules every app follows.
