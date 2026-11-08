# AGENTS.md — apps/assistant/assistant-react

Assistant's **browser layer**: `AssistantChat`, the whole chat with Claude
about one patient's record, over `assistant-core-js`. The SMART shell mounts
it under `PatientChoiceLine`; its props are in the
[README](./README.md).

## Shape

- `src/assistant-chat.tsx` — `AssistantChat` (`fhirBaseUrl`, `patient`,
  `grantedScopes`, `runSmart`, `environment`): the key setup until a key
  works, then `ChatView`, keyed by the chat's storage key so a new patient is
  a new chat. It reads the grant into a `RecordAccess` and builds the
  `FhirRecords` layer the tools read through.
- `src/fhir-records-layer.ts` — `fhirRecordsLayerFor`: `FhirRecords` over
  the page's `RunSmart`, each read a `SmartClient` request and each write
  its `create` or `update` (so each carries the connection's token), a
  `FhirRequestError` mapped to a `FhirReadFailed` and a `ResourceWrite.Failed`
  to a `FhirWriteFailed`.
- `src/assistant-environment.ts` — `AssistantEnvironment` (the storage page
  and the Claude layer for a key) and `BROWSER_ENVIRONMENT` (`window`,
  `Claude.layerForApiKey`); a test passes in-memory storage and a stub.
- `src/use-claude-access.ts` — `useClaudeAccess`, the page logic for the key
  and the models: the kept key tried by listing its models on mount, a new
  key kept only once the API accepts it, the chosen model remembered, and
  Forget key.
- `src/use-chat.ts` — `useChat`, the page logic for one chat: read from
  `sessionStorage` on mount and written after every entry, the style
  (academic once confirmed; locked after the first message), each turn
  streamed into `streamingReply`, each tool round appended and kept as it
  finishes, a round's proposed writes held in `pendingWrites` until
  `decideWrite` has decided each (the turn's `confirmWrites` resumes then;
  `writesAwaitingDecision` while any is undecided), stoppable, and New
  chat.
- `src/chat-view.tsx` — `ChatView`: the toolbar (`ModelPicker`,
  `StyleChoice`, Settings), the `Transcript`, the one `aria-live="polite"`
  line announcing a finished reply, `ChatNotices`, the `Composer`, and the
  academic `ConfirmDialog` and `SettingsDialog`.
- `src/key-setup.tsx` — `KeySetup`: the password field, the line saying the
  key stays in this browser and only goes to Anthropic, "This key wasn't
  accepted", then "Save key".
- `src/model-picker.tsx`, `src/style-choice.tsx` — a native `<select>` of the
  key's models; `SegmentedToggle` Telehealth · Academic, disabled once
  locked.
- `src/transcript.tsx` — `Transcript`: questions, replies (summarized
  thinking folded under "Thinking", text as `ReplyMarkdown`, tool calls as
  `ToolCallCard`s with their results), "Claude declined to answer this.",
  "No reply to this message." under a question nothing answered, and the
  reply streaming in, or the round waiting on the person: its reply with a
  `WriteCard` for each proposed write and its other calls' cards. A tool
  round shows as its reply, each call's card holding the round's result for
  it.
- `src/tool-call-card.tsx` — `ToolCallCard`: a closed `<details>` whose
  line says what Claude looked up ("Searched Observation: code=4548-4, up
  to 20") or wrote and how it came out ("Create Observation: Created
  Observation/123", "…: Declined", "…: Failed: not saved"), opening to the
  parameters and how many records came back (`assistant-core-js`'s
  `ToolCall`).
- `src/write-card.tsx` — `WriteCard`: a write Claude proposed, while its
  round waits: the summary ("Update Observation/o1, 2 fields"), the new
  record's fields or the change field by field (Added / Changed / Removed,
  was → will be), the JSON in a closed `<details>`, then Decline and
  Approve; Decline opens an optional reason, above "Back" and "Decline
  change". Once decided, the buttons give way to "Approved. Saving…" or
  "Declined.".
- `src/reply-markdown.tsx` — `ReplyMarkdown`: `react-markdown` with
  `remark-gfm`.
- `src/chat-notices.tsx` — `ChatNotices`, the lines above the composer: the
  academic banner, storage problems, that a proposed change waits on the
  person, and why the last turn failed (`failure-text.ts` words each
  failure kind).
- `src/composer.tsx` — `Composer`: the message box (disabled while a
  proposed write waits on a decision), Send (Stop while a turn runs), New
  chat.
- `src/settings-dialog.tsx` — `SettingsDialog`: where the key is kept, and
  Forget key.

## Rules

- **Logic lives in the hooks or in core.** Components render a hook's state
  and call its actions; anything that decides without React belongs in
  `assistant-core-js`.
- **Tool cards show no record; a write card shows only the proposal.** A
  card says what was asked and how many records came back, or how a write
  came out; the records themselves, which are the patient's, are never
  rendered. A `WriteCard` shows the record it would create or the change it
  would make, because the person is deciding on exactly that, and only
  while the round waits; the kept round shows the write as a `ToolCallCard`.
- **A write waits on the person, and Stop drops it.** While a round's
  proposals wait on a decision, the composer's message box is disabled
  with a line above it saying why; Stop (or New chat, or leaving) interrupts the turn, so
  nothing is written and the round is not kept. Once every proposal is
  decided, the approved writes are made and the round kept even if Stop is
  pressed meanwhile.
- **Replies render no HTML and reach out only by click.** `skipHtml`, no
  `rehype-raw`; `urlTransform` keeps only absolute `https:` URLs (anything
  else leaves the link's text); links open in a new tab with
  `rel="noopener noreferrer"`; images are not rendered, since an image
  fetches its URL without a click.
- **Messages above buttons.** The academic banner, storage lines, the
  waiting-change line and turn failures sit above the composer; a write
  card's reason field above its buttons; the key setup's rejection sits above
  "Save key"; Forget key's failure above its button.
- **The style is fixed for the chat.** It can change only while the chat is
  empty; academic needs the confirmation each chat, and an empty chat is not
  kept, so a reload asks again.
- **Stop keeps the question.** An aborted turn adds no entry for the reply
  streaming in: its partial reply is dropped. Tool rounds that finished
  before it stay, so no call is kept without its result. A question with
  nothing after it shows "No reply to this message."; the API reads it
  together with the next question.
- **A settled turn from an earlier chat changes nothing.** `useChat` numbers
  its turns; New chat moves the number on, so an interrupted turn that
  settles late cannot write into the new chat.

## References

- [assistant-core-js AGENTS.md](../assistant-core-js/AGENTS.md)
