# AGENTS.md — apps/assistant

**The Assistant**: a chat with Claude over a patient's FHIR record, at
<https://assistant.wildflowerhealth.io/>. It runs entirely in the browser:
the user brings their own Anthropic API key, and the agent reads (and, when
asked, writes) the FHIR server the app signed in to, limited to the grant the
user gave it.

## Packages

- **[`assistant-core-js`](./assistant-core-js/AGENTS.md)** — the chat
  without a DOM: the API key, the model list, the two styles and their
  system prompts, the grant's record access and the read tools it gives,
  patient pinning, the chat codec and the turn loop.
- **[`assistant-react`](./assistant-react/AGENTS.md)** — the chat's screens:
  `AssistantChat`, from key setup to the streamed transcript with its
  tool-call cards and composer, and the tools' reads over the SMART runtime.
- **[`assistant-web`](./assistant-web/AGENTS.md)** — the app: the SMART
  shell (`SmartAppRoot`, `usePatientChoice`, `config.ts`) at
  <https://assistant.wildflowerhealth.io/> (tile `assistant`), which mounts
  `AssistantChat` under the chosen patient.

## Rules

- **The grant decides what the agent can do.** The app asks for everything
  (`system/*.cruds`); the consent prompt lets the Owner narrow that, and the
  granted scope is what the agent works within: it gets only the tools, and
  the record types, the granted scopes cover. The scope string asked for is
  never a statement of what the agent may do.
- **The patient is `smart-app-react`'s.** `?patient=`, then the launch's
  patient, then `PatientPicker` with "All patients", exactly as Plots does.
- **A chosen patient is pinned in the tools.** Every search is kept to that
  patient and every record read back is checked to be theirs, in code, not
  by asking the model; "All patients" lets the agent search the whole
  server.

## References

- [Epic #1525](https://github.com/wildflowerhealthio/Wildflower/issues/1525) —
  the decisions the chat is built to.
- [apps/plots/AGENTS.md](../plots/AGENTS.md) — the sibling the shell mirrors.
- [slices/smart-app-react/AGENTS.md](../../slices/smart-app-react/AGENTS.md) —
  the shell and the patient choice.
- [apps/AGENTS.md](../AGENTS.md) — the rules every app follows.
