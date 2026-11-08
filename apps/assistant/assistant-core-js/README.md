# @wildflowerhealthio/assistant-core-js

Assistant's core: the Claude API key and model choice kept in the browser,
the telehealth and academic styles and their system prompts, the chat codec
kept in `sessionStorage`, and one streamed turn through `@anthropic-ai/sdk`.
No DOM, no React. See [AGENTS.md](./AGENTS.md) for its modules and rules.

```ts
import { Chat, Claude, Turn } from '@wildflowerhealthio/assistant-core-js'

const asked = Chat.append(Chat.start('telehealth'), Chat.questionOf('What does my record say?'))
const entry = Turn.run({ chat: asked, model, patient }, (delta) => render(delta)).pipe(
  Effect.provide(Layer.merge(Claude.layerForApiKey(apiKey), DateTime.layerCurrentZoneLocal))
)
```

Tests stub the API through `@wildflowerhealthio/assistant-core-js/test-helpers`
(`stubClaude`, `scriptedReply`, `heldReply`, `memoryStoragePage`).
