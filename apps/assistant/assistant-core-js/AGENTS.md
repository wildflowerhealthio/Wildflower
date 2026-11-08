# AGENTS.md — apps/assistant/assistant-core-js

Assistant's **core**: what the chat with Claude decides, with no DOM and no
React. The person's own API key and model choice, the two styles and their
system prompts, what the grant lets the agent read and the tools that follow
from it, the chat as it is kept in the tab, and the turn loop through
`@anthropic-ai/sdk`, which pauses for the person to approve or decline each
write the agent proposes. `assistant-react` draws it.

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
  (`AuthenticationError` → `key-rejected`, `RateLimitError` → `rate-limited`,
  `OverloadedError` → `overloaded`, `APIConnectionError` → `unreachable`,
  any other `APIError` → `api-error` with its status, anything else thrown →
  `unexpected-error`); a model listing that does not decode is
  `model-list-unreadable`.
- `src/claude-model.ts` — `ClaudeModel`: `list` decodes `GET /v1/models`
  (every page) into id, display name, release instant and
  `supportsAdaptiveThinking`, read one way from the SDK's `capabilities`
  (`null` supports nothing), keeps the `claude-` models, newest first
  (`choicesOf`); `startingModelOf` is the remembered id while it is
  listed, else `claude-sonnet-5`, else the first; the remembered id is kept
  in `localStorage` at `wildflower.assistant.model`.
- `src/style.ts` — `Style`: `telehealth` (the default) or `academic`, and
  `systemPromptOf`, which joins the style's voice
  (`src/telehealth-voice.ts`, `src/academic-voice.ts`),
  `ChatPatient.paragraphOf` the patient, today's date and
  `RecordAccess.paragraphOf` the grant, one paragraph each. The telehealth voice says who to contact and how to look
  them up with the tools.
- `src/record-access.ts` — `RecordAccess`: from `SmartConnection.grantedScopes`,
  the types the agent may read (`r`), search (`s`), create (`c`) and update
  (`u`), each
  every type (a `*` scope) or the named R4 types; coverage is `scopes-core`'s
  (`Grant`, `MultiScope.within`), asked in every FHIR context, as both the v2
  letter and the v1 word. `paragraphOf` says it in words for the prompt:
  what can be read, created and changed, and, when anything can be written,
  that each write is approved by the person first and that a mistaken
  record is marked `entered-in-error` through an update, never deleted.
- `src/patient-pin.ts` — `PatientPin`: per R4 type, how a chat about one
  patient keeps it to them (`Patient` by `_id`; the Patient compartment's
  types by `patient`, or `subject=Patient/<id>`; practitioners,
  organizations, medications and the like as they are), the parameters a
  pinned search may not set, and `isAboutAnotherPatient`, the check every
  record read back passes.
- `src/search-param.ts` — `SearchParam`: one search parameter as the agent
  gives it (`name`, `value`), the `Name` grammar a search's names are held
  to, and `baseNameOf` (the parameter a modifier or chain is of).
- `src/fhir-records.ts` — `FhirRecords`, the Effect service the tools read
  and write the FHIR server through (its base, one GET of a path under it as
  JSON, and `fhir-r4`'s `ResourceWrite` `create` and `update`), and
  `FhirReadFailed` and `FhirWriteFailed`, values saying why a read or a write
  failed.
- `src/tools.ts` — `Tools`: `make` builds a chat's tool definitions from
  its `RecordAccess` and patient; `run` runs one read call against
  `FhirRecords` and succeeds with its `tool_result`; `propose` turns a write
  call into a `WriteProposal` or the result refusing it; `carryOut` makes
  a decided proposal and succeeds with its `tool_result`; `versionsReadIn`
  is the version of each record the chat has read or written, from its kept
  results.
- `src/write-proposal.ts` — `WriteProposal`: a write the agent proposed
  (`create` with the resource as it will be sent; `update` with the
  resource, the version it is against and its `FieldDiff`s from the record
  as it is now), `Decision` (`approved`, or `declined` with an optional
  reason), and `summaryOf` ("Create Observation", "Update
  MedicationRequest/123, 2 fields").
- `src/tool-call.ts` — `ToolCall`: a kept call in words for the
  transcript's card (`summaryOf`, `parametersOf`, `resultSummaryOf`: how
  many records came back, or "Created Observation/123", "Declined",
  "Failed: …").
- `src/chat-patient.ts` — `ChatPatient`: one patient's FHIR `Patient`
  record (with its id) or every patient; `keyOf` (the id, or `*`),
  `patientIdIfOne`, and `paragraphOf`, whose record the chat is about in
  words, the name and birth date read from the record (`fhir-r4`'s
  `HumanName.displayName`).
- `src/chat.ts` — `Chat`: a style and its entries (`question`; `reply` with
  its `modelId` and `end_turn` / `max_tokens`; `tool-round`, a reply that
  stopped for `tool_use` with its `modelId` and the results of the calls it
  ran; `refusal` with its `modelId`), the codec, `requestMessagesOf` (what a
  turn sends), `toolCallsOf` and `toolResultsByCallIdOf`, and the chat's place in
  `sessionStorage` at `wildflower.assistant-chat:<fhirBaseUrl>:<patient>`.
- `src/turn.ts` — `Turn`: `paramsOf`, the streamed request, and `run`, the
  loop: stream a reply, reporting each text and thinking delta; on
  `tool_use`, run its reads and propose its writes side by side, ask for
  the person's decisions on the proposals (`Report.confirmWrites`, with the
  round's `ProposedWrites`), make the approved writes, report the
  `tool-round` and stream again; on any other stop, map `stop_reason` to the
  entry the chat keeps.
- `src/test-helpers.ts` — the `./test-helpers` subpath: in-memory and
  blocked storage pages, `stubClaude` with scripted or held replies,
  `stubFhirRecords` answering reads by path prefix and recording writes
  (stored by `storeWrite` unless a test answers them), and the SDK and FHIR
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
  SDK's `BetaTool`, except `create_record` and `update_record`: a resource
  is an open object, which a strict schema can't express, so those two list
  only `resource` and its `resourceType` enum. Each call's input is decoded
  with Effect Schema (excess properties refused) before it runs.
- **Writes are proposed, decided, then made, one card per write.**
  `create_record` and `update_record` are offered for the types the grant
  can create (`c`) and update (`u`) that the chat can keep to its patient
  (no `Patient` create in a chat about one patient); there is no delete
  tool under any grant. A round's reads run at once and its writes become
  proposals; the turn pauses on `confirmWrites` until every proposal is
  decided, makes the approved ones one after another in call order (an
  update as a PUT with `If-Match: W/"<versionId>"`), and sends every result
  back in one user message, in call order. Once decided, the writes and the
  round's report are uninterruptible, so a write the server made is never
  left out of the chat; stopped before then, the round keeps nothing.
- **An update is against the version the agent read.** It is refused unless
  the record was read (or written) in this chat (`versionsReadIn`, from the
  kept results, the latest version of each); the record is read again when
  the proposal is built, and refused as changed ("The record changed since
  you read it; re-read it first.") unless it is still that version. The
  proposal's diff is `fhir-r4`'s `diffJson` of the two with server-managed
  `meta` dropped; a change that changes nothing is refused. A 412 when it
  is saved gives the agent the same text.
- **A write's result.** Saved: `Tools.WriteRecordResult`, the stored
  record with its type, id and `versionId`. Declined: "The user declined
  this change.", then "Reason: …" when the person gave one. Declined and
  failed are both `is_error: true`, so the agent treats the change as not
  made.
- **A chosen patient is pinned in the tools, not the prompt.** A search
  gets the type's pin parameter, a parameter that names whose records to read
  is refused, and every record read back (a page, includes, `read_record`) is
  checked to be about that patient or no patient; a type with no pin is not
  offered. A record created in a chat about one patient is refused when its
  `subject` or `patient` names another patient, has those elements pointed
  at the patient, and is refused when its type is about a patient and it
  has neither, so the agent adds one; a record about no one patient is
  created as given. An update is refused when the record, now or as
  proposed, is about another patient. With "All patients", writes are sent
  as given. A `next` cursor is the next link's path under the FHIR base,
  base64url-encoded; one that leaves the base or names a type not offered is
  refused.
- **Tool results.** Each tool's result is defined once as a `Schema.parseJson`
  schema the tool encodes with and the transcript's card decodes with:
  `Tools.PageResult` (`search_records`, `next_page`), `Tools.ReadRecordResult`
  and `Tools.CapabilitiesResult`. One page per search: `_count` 20 unless
  the agent sets it (`AskedPageSize`, a whole number of at least 1), 50 at
  most; compact JSON `{ resources, total?, more, next? }`. A failed
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
  grows; a tool round is one entry, kept once its calls finish, so no call
  is ever kept without its result. What goes back to the API is derived: a
  tool round is its reply then one user message of its results, a declined
  question is left out with everything up to its
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
  text and tool inputs go only into the chat: `FhirReadFailed`,
  `FhirWriteFailed` and the tools' refusals are values turned into tool
  results, never thrown or logged. The client's OpenTelemetry spans
  are `metadata_only`, and it sends no trace context to Anthropic.
- **Storage refusals.** A refused read of the key or the model choice reads
  as none; every other refusal fails as `kitchen-sink`'s `StorageBlocked`.
  Each call reads `page.localStorage` / `page.sessionStorage` inside the
  Effect, since a blocked browser can throw on the property itself.
- **Prompts are plain prose for current models**, one file per style, with
  no capitalised MUSTs. Each voice says to write only when asked, saying
  first what it will propose. The record-access paragraph says which types
  the agent can read, create and change, and how writes go.

## References

- [assistant-react AGENTS.md](../assistant-react/AGENTS.md)
