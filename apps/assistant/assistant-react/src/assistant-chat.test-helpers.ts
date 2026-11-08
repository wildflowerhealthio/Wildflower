import { AuthenticationError } from '@anthropic-ai/sdk'
import { render, type RenderResult } from '@testing-library/react'
import {
  ApiKey,
  type Chat,
  type ChatPatient,
  ClaudeModel,
} from '@wildflowerhealthio/assistant-core-js'
import {
  type HeldReply,
  memoryStoragePage,
  modelInfoOf,
  type StubClaude,
  stubClaude,
} from '@wildflowerhealthio/assistant-core-js/test-helpers'
import { Option, Redacted } from 'effect'
import { createElement } from 'react'

import { AssistantChat } from './assistant-chat.tsx'
import type { AssistantEnvironment } from './assistant-environment.ts'

/** The key every stub accepts unless a test says otherwise. */
const GOOD_KEY = 'sk-ant-good'

/** The models every stub lists: Sonnet 5 (the default) and Opus 5. */
const LISTED_MODELS = [
  modelInfoOf({
    id: ClaudeModel.DEFAULT_ID,
    displayName: 'Claude Sonnet 5',
    createdAt: '2026-05-01T00:00:00Z',
  }),
  modelInfoOf({
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    createdAt: '2026-08-01T00:00:00Z',
  }),
]

const PATIENT: ChatPatient.Type = {
  kind: 'patient',
  patientId: 'p1',
  name: 'Ada Lovelace',
  birthDate: Option.some('1815-12-10'),
}

const PLACE: Chat.ChatPlace = { fhirBase: 'https://fhir.example/r4', patient: PATIENT }

/** A rendered chat over in-memory storage, and the stub client its good key reaches. */
interface RenderedChat {
  readonly rendered: RenderResult
  readonly page: ReturnType<typeof memoryStoragePage>
  readonly claude: StubClaude
}

/**
 * Render `AssistantChat` at {@link PLACE} over `page`, with `keptKey` kept:
 * {@link GOOD_KEY} reaches a stub listing {@link LISTED_MODELS} and
 * answering with `replies` in turn; the API rejects any other key.
 */
const renderChat = ({
  replies = [],
  keptKey = Option.none(),
  page = memoryStoragePage(),
}: {
  readonly replies?: readonly HeldReply[]
  readonly keptKey?: Option.Option<string>
  readonly page?: ReturnType<typeof memoryStoragePage>
} = {}): RenderedChat => {
  Option.map(keptKey, (key) => page.localStorage.items.set(ApiKey.STORAGE_KEY, key))
  const claude = stubClaude({ models: LISTED_MODELS, replies })
  const rejecting = stubClaude({
    modelsThrow: new AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()),
  })
  const environment: AssistantEnvironment = {
    page,
    claudeLayerFor: (apiKey) =>
      Redacted.value(apiKey) === GOOD_KEY ? claude.layer : rejecting.layer,
  }
  const rendered = render(
    createElement(AssistantChat, { fhirBase: PLACE.fhirBase, patient: PLACE.patient, environment })
  )
  return { rendered, page, claude }
}

/** `showModal` as a stand-in: the dialog is open. */
function showModal(this: HTMLDialogElement): void {
  this.setAttribute('open', '')
}

/** `close` as a stand-in: the dialog is closed, and says so. */
function close(this: HTMLDialogElement): void {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

/** Stand in for the `<dialog>` methods jsdom lacks; returns what puts the originals back. */
const stubDialogMethods = (): (() => void) => {
  const saved = (['showModal', 'close'] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const
  )
  HTMLDialogElement.prototype.showModal = showModal
  HTMLDialogElement.prototype.close = close
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name)
      else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor)
    }
  }
}

export { GOOD_KEY, PLACE, renderChat, stubDialogMethods }
export type { RenderedChat }
