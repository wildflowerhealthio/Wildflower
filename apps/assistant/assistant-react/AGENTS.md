# AGENTS.md — apps/assistant/assistant-react

Assistant's **browser layer**: `AssistantChat`, the whole chat with Claude
about one patient's record, over `assistant-core-js`. The SMART shell mounts
it under `PatientChoiceLine`; its props are in the
[README](./README.md).

## Shape

- `src/assistant-chat.tsx` — `AssistantChat` (`fhirBase`, `patient`,
  `grantedScopes`, `runSmart`, `environment`): the key setup until a key
  works, then `ChatView`, keyed by the chat's storage key so a new patient is
  a new chat. It reads the grant into a `RecordAccess` and builds the
  `FhirRecords` layer the tools read through.
- `src/fhir-records-layer.ts` — `fhirRecordsLayerFor`: `FhirRecords` over
  the page's `RunSmart`, each read a `SmartClient` request (so it carries the
  connection's token), its `FhirRequestError` mapped to a `FhirReadFailed`.
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
  finishes, stoppable, and New chat.
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
  reply streaming in. `tool-results` entries show only in their calls'
  cards.
- `src/tool-call-card.tsx` — `ToolCallCard`: a closed `<details>` whose
  line says what Claude looked up ("Searched Observation: code=4548-4, up
  to 20"), opening to the parameters and how many records came back
  (`assistant-core-js`'s `ToolCall`).
- `src/reply-markdown.tsx` — `ReplyMarkdown`: `react-markdown` with
  `remark-gfm`.
- `src/chat-notices.tsx` — `ChatNotices`, the lines above the composer: the
  academic banner, storage problems, and why the last turn failed
  (`failure-text.ts` words each failure kind).
- `src/composer.tsx` — `Composer`: the message box, Send (Stop while a reply
  streams), New chat.
- `src/settings-dialog.tsx` — `SettingsDialog`: where the key is kept, and
  Forget key.

## Rules

- **Logic lives in the hooks or in core.** Components render a hook's state
  and call its actions; anything that decides without React belongs in
  `assistant-core-js`.
- **Tool cards show no record.** A card says what was asked and how many
  records came back; the records themselves, which are the patient's, are
  never rendered.
- **Replies render no HTML and reach out only by click.** `skipHtml`, no
  `rehype-raw`; `urlTransform` keeps only absolute `https:` URLs (anything
  else leaves the link's text); links open in a new tab with
  `rel="noopener noreferrer"`; images are not rendered, since an image
  fetches its URL without a click.
- **Messages above buttons.** The academic banner, storage lines and turn
  failures sit above the composer; the key setup's rejection sits above
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
