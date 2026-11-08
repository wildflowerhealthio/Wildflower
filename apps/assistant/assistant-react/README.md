# @wildflowerhealthio/assistant-react

Assistant's browser UI: `AssistantChat`, the whole chat with Claude about
one patient's record, from asking for the person's API key to the streamed
transcript. See [AGENTS.md](./AGENTS.md) for its parts and rules.

## `AssistantChat`

```tsx
import { AssistantChat } from '@wildflowerhealthio/assistant-react'

;<AssistantChat
  fhirBaseUrl={connection.fhirBaseUrl}
  patient={{ kind: 'patient', patientId, name, birthDate }}
  grantedScopes={useGrantedScopes()}
  runSmart={useRunSmart()}
/>
```

| Prop            | Type                                     | What it is                                                                                                                                                                                 |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fhirBaseUrl`   | `string`                                 | The connected FHIR server's base URL. Chats are kept per server.                                                                                                                           |
| `patient`       | `ChatPatient.Type` (`assistant-core-js`) | `{ kind: 'patient', patientId, name, birthDate }` (birth date an `Option` of the record's `birthDate`) or `{ kind: 'all-patients' }`. Chats are kept per patient.                          |
| `grantedScopes` | `readonly Scope.Any[]` (`scopes-core`)   | The scopes the sign-in was granted: `SmartConnection.grantedScopes`, or `smart-app-react`'s `useGrantedScopes()`. They decide which tools Claude gets and which record types each reaches. |
| `runSmart`      | `RunSmart` (`fhir-r4-react/smart`)       | Runs the tools' reads over the page's SMART connection: `useRunSmart()` under `SmartHandshakeGate`.                                                                                        |
| `environment`   | `AssistantEnvironment`, optional         | The storage and Claude API the chat runs against. Defaults to `BROWSER_ENVIRONMENT` (`window`'s storage, the real API); tests pass in-memory storage and a stub.                           |

Any other `<div>` prop (`className`, `id`, `aria-*`, `data-*`) goes to the
root `<div>`.

`patient`'s kinds are `smart-app-react`'s `PatientChoice`'s, with the name
and birth date the system prompt states added: the shell reads the patient
(as `PatientChoiceLine` does) and passes them. A new `fhirBaseUrl` or patient
is a new chat, with nothing carried over from the last; the key and model
stay as they are.

Claude reads the record only through its tools, and only what the grant
covers; with one patient chosen, the tools keep every read to that patient.
Each tool call shows in the transcript as a one-line card that opens to its
parameters and how many records came back.

The key and the chosen model are kept in `localStorage`
(`wildflower.assistant.api-key`, `wildflower.assistant.model`); the chat in
`sessionStorage` (`wildflower.assistant-chat:<fhirBaseUrl>:<patient id or *>`).
