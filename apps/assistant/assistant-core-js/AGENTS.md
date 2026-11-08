# AGENTS.md — apps/assistant/assistant-core-js

Assistant's **core**: what the chat with Claude decides, with no DOM and no
React. The person's own API key and model choice, the two styles and their
system prompts, the chat as it is kept in the tab, and one streamed turn
through `@anthropic-ai/sdk`. `assistant-react` draws it.

## Shape

Every module is a namespace (`src/index.ts`):

- `src/api-key.ts` — `ApiKey`: the key, trimmed and held `Redacted`, kept in
  `localStorage` at `wildflower.assistant.api-key` (`read`, `write`,
  `forget`, `fromInput`). A refused read is no key.
- `src/claude.ts` — `Claude`, the Effect service the API is reached through:
  the structural `ClaudeClient` (the model list and a streamed beta message)
  an `Anthropic` client satisfies, built by `Claude.layerForApiKey` with
  `dangerouslyAllowBrowser`. `ClaudeRequestFailed` is how a call fails:
  `fromThrown` matches the SDK's error classes, most specific first
  (`AuthenticationError` → `KeyRejected`, `RateLimitError` → `RateLimited`,
  `OverloadedError` → `Overloaded`, `APIConnectionError` → `Unreachable`,
  any other `APIError` or throw → `Failed` with its status).
- `src/claude-model.ts` — `ClaudeModel`: `list` decodes `GET /v1/models`
  (every page) into id, display name, release instant and whether the
  capabilities accept `thinking: { type: 'adaptive' }`, keeps the `claude-`
  models, newest first; `choose` starts on the remembered id while it is
  listed, else `claude-sonnet-5`, else the first; the remembered id is kept
  in `localStorage` at `wildflower.assistant.model`.
- `src/style.ts` — `Style`: `telehealth` (the default) or `academic`, and
  `systemPromptOf`, which joins the style's voice
  (`src/telehealth-voice.ts`, `src/academic-voice.ts`), whose record the chat
  is about, today's date and what the assistant can do with the record, one
  paragraph each.
- `src/chat-patient.ts` — `ChatPatient`: one named patient (id, name, birth
  date) or every patient, and `keyOf` (the id, or `*`).
- `src/chat.ts` — `Chat`: a style and its entries (`question`, `reply` with
  its model and `end_turn` / `max_tokens`, `refusal` with its model), the
  codec, `requestMessagesOf` (what a turn sends), and the chat's place in
  `sessionStorage` at `wildflower.assistant-chat:<fhirBase>:<patient>`.
- `src/turn.ts` — `Turn`: `paramsOf`, the streamed request, and `run`, which
  streams it, reports each text and thinking delta, and maps the final
  message's `stop_reason` to the entry the chat keeps.
- `src/test-helpers.ts` — the `./test-helpers` subpath: in-memory and
  blocked storage pages, `stubClaude` with scripted or held replies, and the
  SDK shapes a reply streams.

## Rules

- **A turn's request.** `max_tokens: 64000`, `tools: []`, top-level
  `cache_control: { type: 'ephemeral' }`, `thinking: { type: 'adaptive',
  display: 'summarized' }` only where the model's capabilities accept it,
  and server-side refusal fallbacks on every model: `betas:
  ['server-side-fallback-2026-07-01']` with `fallbacks: 'default'` (the API
  picks the fallback by refusal category; a model without fallbacks runs
  alone). Requests go through `client.beta.messages.stream`, so the stored
  messages are the SDK's `Beta*MessageParam` types.
- **`stop_reason` before `content`.** `end_turn` and `max_tokens` keep the
  reply as returned; `refusal` keeps a `refusal` entry and drops whatever was
  written; anything else fails as `UnexpectedStop`, naming only the reason.
- **Append-only, stored as returned.** `Chat.append` is the only way a chat
  grows. What goes back to the API is derived: a declined question is left
  out with its refusal, and a reply a fallback switched models in is sent
  without the thinking and tool calls before its last `fallback` block.
- **The message codec checks an outline.** `Chat`'s message schemas are
  `Schema.declare` guards on role and typed blocks that assert the SDK's
  types; every block was written by this app from the SDK, and mirroring the
  SDK's block types in schemas would drift from it.
- **No model or patient text in an error, a log or a span.**
  `ClaudeRequestFailed` carries a kind and a status, `UnexpectedStop` a stop
  reason, `StoredChatUnreadable` nothing; a stored chat's parse error, which
  would quote it, never leaves `Chat.read`. The client's OpenTelemetry spans
  are `metadata_only`, and it sends no trace context to Anthropic.
- **Storage refusals.** A refused read of the key or the model choice reads
  as none; every other refusal fails as `kitchen-sink`'s `StorageBlocked`.
  Each call reads `page.localStorage` / `page.sessionStorage` inside the
  Effect, since a blocked browser can throw on the property itself.
- **Prompts are plain prose for current models**, one file per style, with
  no capitalised MUSTs. The record-access paragraph says the assistant has
  no tools; the read tools replace it.

## References

- [assistant-react AGENTS.md](../assistant-react/AGENTS.md)
