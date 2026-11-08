# @wildflowerhealthio/assistant-react

Assistant's browser UI: `AssistantChat`, the whole chat with Claude about
one patient's record, from asking for the person's API key to the streamed
transcript. See [AGENTS.md](./AGENTS.md) for its parts and rules.

## `AssistantChat`

```tsx
import { AssistantChat } from '@wildflowerhealthio/assistant-react'

;<AssistantChat
  fhirBase={connection.fhirBaseUrl}
  patient={{ kind: 'patient', patientId, name, birthDate }}
/>
```

| Prop          | Type                                     | What it is                                                                                                                                                        |
| ------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fhirBase`    | `string`                                 | The connected FHIR server's base URL. Chats are kept per server.                                                                                                  |
| `patient`     | `ChatPatient.Type` (`assistant-core-js`) | `{ kind: 'patient', patientId, name, birthDate }` (birth date an `Option` of the record's `birthDate`) or `{ kind: 'all-patients' }`. Chats are kept per patient. |
| `environment` | `AssistantEnvironment`, optional         | The storage and Claude API the chat runs against. Defaults to `BROWSER_ENVIRONMENT` (`window`'s storage, the real API); tests pass in-memory storage and a stub.  |

Any other `<div>` prop (`className`, `id`, `aria-*`, `data-*`) goes to the
root `<div>`.

`patient`'s kinds are `smart-app-react`'s `PatientChoice`'s, with the name
and birth date the system prompt states added: the shell reads the patient
(as `PatientChoiceLine` does) and passes them. A new `fhirBase` or patient
is a new chat, with nothing carried over from the last; the key and model
stay as they are.

The key and the chosen model are kept in `localStorage`
(`wildflower.assistant.api-key`, `wildflower.assistant.model`); the chat in
`sessionStorage` (`wildflower.assistant-chat:<fhirBase>:<patient id or *>`).
