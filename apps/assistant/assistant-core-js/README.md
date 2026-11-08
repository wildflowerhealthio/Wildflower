# @wildflowerhealthio/assistant-core-js

Assistant's core: the Claude API key and model choice kept in the browser,
the telehealth and academic styles and their system prompts, the read and
write tools the grant allows with a chosen patient pinned, the chat codec
kept in `sessionStorage`, and the turn loop through `@anthropic-ai/sdk`,
which pauses on each proposed write for the person's decision. No DOM, no
React. See [AGENTS.md](./AGENTS.md) for its modules and rules.

```ts
import { Chat, Claude, RecordAccess, Turn } from '@wildflowerhealthio/assistant-core-js'

const asked = Chat.append(Chat.start('telehealth'), Chat.questionOf('What does my record say?'))
const recordAccess = RecordAccess.fromGrantedScopes(connection.grantedScopes)
const entry = Turn.run(
  { chat: asked, model, patient, recordAccess },
  {
    delta: (delta) => render(delta),
    toolRound: (round) => keep(round),
    // Show the proposals; succeed with a decision for each once the person answers.
    confirmWrites: (proposed) => askThePerson(proposed),
  }
).pipe(
  Effect.provide(
    Layer.mergeAll(Claude.layerForApiKey(apiKey), fhirRecordsLayer, DateTime.layerCurrentZoneLocal)
  )
)
```

`fhirRecordsLayer` provides `FhirRecords`, the FHIR server the tools read and write;
`assistant-react` builds it over the page's SMART runtime.

Tests stub the API and the FHIR server through
`@wildflowerhealthio/assistant-core-js/test-helpers` (`stubClaude`,
`scriptedReply`, `heldReply`, `stubFhirRecords`, `memoryStoragePage`).
