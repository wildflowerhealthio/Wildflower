# AGENTS.md — apps/assistant

**The Assistant**: a chat with Claude over a patient's FHIR record, at
<https://assistant.wildflowerhealth.io/>. It runs entirely in the browser:
the user brings their own Anthropic API key, and the agent reads (and, when
asked, writes) the FHIR server the app signed in to, limited to the grant the
user gave it.

## Packages

- **[`assistant-web`](./assistant-web/AGENTS.md)** — the app: the SMART
  shell (`SmartAppRoot`, `usePatientChoice`, `config.ts`) at
  <https://assistant.wildflowerhealth.io/> (tile `assistant`). Under a
  chosen patient the page is empty until the chat lands.

## Rules

- **The grant decides what the agent can do.** The app asks for everything
  (`system/*.cruds`); the consent prompt lets the Owner narrow that, and the
  granted scope is what the agent works within. The scope string asked for is
  never a statement of what the agent may do.
- **The patient is `smart-app-react`'s.** `?patient=`, then the launch's
  patient, then `PatientPicker` with "All patients", exactly as Plots does.

## References

- [Epic #1525](https://github.com/wildflowerhealthio/Wildflower/issues/1525) —
  the decisions the chat is built to.
- [apps/plots/AGENTS.md](../plots/AGENTS.md) — the sibling the shell mirrors.
- [slices/smart-app-react/AGENTS.md](../../slices/smart-app-react/AGENTS.md) —
  the shell and the patient choice.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.
