# AGENTS.md — apps/assistant/assistant-core-js

Assistant's **core**: what the chat with Claude decides, with no DOM and no
React. The person's own API key and model choice, the two styles and their
system prompts, what the grant lets the agent read and the tools that follow
from it, the chat as it is kept in the tab, and the turn loop through
`@anthropic-ai/sdk`. `assistant-react` draws it.

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
  is about, today's date and `RecordAccess.paragraphOf` the grant, one
  paragraph each. The telehealth voice says who to contact and how to look
  them up with the tools.
- `src/record-access.ts` — `RecordAccess`: from `SmartConnection.grantedScopes`,
  the types the agent may read (`r`), search (`s`) and write (`c`/`u`), each
  every type (a `*` scope) or the named R4 types; coverage is `scopes-core`'s
  (`Grant`, `MultiScope.within`), asked in every FHIR context, as both the v2
  letter and the v1 word. `paragraphOf` says it in words for the prompt.
- `src/patient-pin.ts` — `PatientPin`: per R4 type, how a chat about one
  patient keeps it to them (`Patient` by `_id`; the Patient compartment's
  types by `patient`, or `subject=Patient/<id>`; practitioners,
  organizations, medications and the like as they are), the parameters a
  pinned search may not set, and `isAboutAnotherPatient`, the check every
  record read back passes.
- `src/fhir-records.ts` — `FhirRecords`, the Effect service the tools read
  the FHIR server through (its base, and one GET of a path under it as JSON),
  and `FhirReadFailed`, a value saying why a read failed.
- `src/tools.ts` — `Tools`: `make` builds a chat's tool definitions from
  its `RecordAccess` and patient; `run` runs one call against `FhirRecords`
  and succeeds with its `tool_result`.
- `src/tool-call.ts` — `ToolCall`: a kept call in words for the
  transcript's card (`summaryOf`, `parametersOf`, `resultSummaryOf`).
- `src/chat-patient.ts` — `ChatPatient`: one named patient (id, name, birth
  date) or every patient, and `keyOf` (the id, or `*`).
- `src/chat.ts` — `Chat`: a style and its entries (`question`, `reply` with
  its model and `end_turn` / `max_tokens` / `tool_use`, `tool-results`,
  `refusal` with its model), the codec, `requestMessagesOf` (what a turn
  sends), `toolCallsOf` and `toolResultsByCallIdOf`, and the chat's place in
  `sessionStorage` at `wildflower.assistant-chat:<fhirBase>:<patient>`.
- `src/turn.ts` — `Turn`: `paramsOf`, the streamed request, and `run`, the
  loop: stream a reply, reporting each text and thinking delta; on
  `tool_use`, run its calls side by side, report the round (the reply and one
  `tool-results` message) and stream again; on any other stop, map
  `stop_reason` to the entry the chat keeps.
- `src/test-helpers.ts` — the `./test-helpers` subpath: in-memory and
  blocked storage pages, `stubClaude` with scripted or held replies,
  `stubFhirRecords` answering reads by path prefix, and the SDK and FHIR
  shapes a turn reads.

## Rules

- **A turn's request.** `max_tokens: 64000`, the chat's tools, top-level
  `cache_control: { type: 'ephemeral' }`, `thinking: { type: 'adaptive',
  display: 'summarized' }` only where the model's capabilities accept it,
  and server-side refusal fallbacks on every model: `betas:
  ['server-side-fallback-2026-07-01']` with `fallbacks: 'default'` (the API
  picks the fallback by refusal category; a model without fallbacks runs
  alone). Requests go through `client.beta.messages.stream`, so the stored
  messages are the SDK's `Beta*MessageParam` types.
- **The grant decides the tools, fixed for the chat.** `Tools.make` is a
  function of the `RecordAccess` and the patient alone, so every request of
  a chat sends the same `tools` and the prompt cache holds. `search_records`
  (with `next_page` and `capabilities`) is offered when some type can be
  searched, `read_record` when some type can be read, each with an `enum` of
  only those types. Definitions are strict JSON Schema (`strict: true`,
  `additionalProperties: false`, every property `required`), typed as the
  SDK's `BetaTool`; each call's input is decoded with Effect Schema
  (excess properties refused) before it runs.
- **A chosen patient is pinned in the tools, not the prompt.** A search
  gets the type's pin parameter, a parameter that names whose records to read
  is refused, and every record read back (a page, includes, `read_record`) is
  checked to be about that patient or no patient; a type with no pin is not
  offered. A `next` cursor is the next link's path under the FHIR base,
  base64url-encoded; one that leaves the base or names a type not offered is
  refused.
- **Tool results.** One page per search: `_count` 20 unless the agent sets
  it, 50 at most; compact JSON `{ resources, total?, more, next? }`. A failed
  call is a result with `is_error: true` and why, the server's
  `OperationOutcome` text included; it is not a turn failure. All of a
  reply's calls run at once (`Effect.forEach` unbounded) and their results go
  back in one user message, in call order. Only calls after a reply's last
  `fallback` block run (`Chat.toolCallsOf`).
- **`stop_reason` before `content`.** `tool_use` runs the calls (none to run
  fails as `UnexpectedStop`); `end_turn` and `max_tokens` keep the reply as
  returned, but a `max_tokens` holding a `tool_use` block fails as
  `UnexpectedStop` without running it, its input cut short; `refusal` keeps
  a `refusal` entry and drops whatever was written; anything else fails as
  `UnexpectedStop`, naming only the reason.
- **Append-only, stored as returned.** `Chat.append` is the only way a chat
  grows; a tool round is appended whole (reply, then results) once its calls
  finish, so no call is ever kept without its result. What goes back to the
  API is derived: a declined question is left out with everything up to its
  refusal, and a reply a fallback switched models in is sent without the
  thinking and tool calls before its last `fallback` block.
- **The message codec checks an outline.** `Chat`'s message schemas are
  `Schema.declare` guards on role and typed blocks that assert the SDK's
  types; every block was written by this app from the SDK, and mirroring the
  SDK's block types in schemas would drift from it.
- **No model or patient text in an error, a log or a span.**
  `ClaudeRequestFailed` carries a kind and a status, `UnexpectedStop` a stop
  reason, `StoredChatUnreadable` nothing; a stored chat's parse error, which
  would quote it, never leaves `Chat.read`. Tool results, `OperationOutcome`
  text and tool inputs go only into the chat: `FhirReadFailed` and the tools'
  refusals are values turned into tool results, never thrown or logged. The client's OpenTelemetry spans
  are `metadata_only`, and it sends no trace context to Anthropic.
- **Storage refusals.** A refused read of the key or the model choice reads
  as none; every other refusal fails as `kitchen-sink`'s `StorageBlocked`.
  Each call reads `page.localStorage` / `page.sessionStorage` inside the
  Effect, since a blocked browser can throw on the property itself.
- **Prompts are plain prose for current models**, one file per style, with
  no capitalised MUSTs. The record-access paragraph says which types the
  agent can read, and that it can't create or change records.

## References

- [assistant-react AGENTS.md](../assistant-react/AGENTS.md)
