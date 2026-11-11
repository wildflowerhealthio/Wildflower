import { AuthenticationError } from '@anthropic-ai/sdk'
import { render, type RenderResult } from '@testing-library/react'
import { ApiKey, Chat, ClaudeModel } from '@wildflowerhealthio/assistant-core-js'
import {
  type HeldReply,
  type MemoryStorage,
  memoryStorage,
  modelInfoOf,
  onePatientChat,
  type StubClaude,
  stubClaude,
} from '@wildflowerhealthio/assistant-core-js/test-helpers'
import {
  STUB_FHIR_BASE,
  type StubAnswers,
  type StubFhirServer,
  stubSmartRuntime,
} from '@wildflowerhealthio/fhir-r4-react/smart/test-helpers'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { Effect, Layer, Option, Redacted } from 'effect'
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

const PATIENT = onePatientChat({
  id: 'p1',
  given: 'Ada',
  family: 'Lovelace',
  birthDate: '1815-12-10',
})

const PLACE: Chat.Place = { fhirBaseUrl: STUB_FHIR_BASE, patient: PATIENT }

/** A rendered chat over in-memory storage, the stub client its good key reaches, and its FHIR server. */
interface RenderedChat {
  readonly rendered: RenderResult
  readonly storage: MemoryStorage
  readonly claude: StubClaude
  readonly fhir: StubFhirServer
}

/**
 * Render `AssistantChat` at {@link PLACE} over `storage`, with `keptKey` kept:
 * {@link GOOD_KEY} reaches a stub listing {@link LISTED_MODELS} and
 * answering with `replies` in turn; the API rejects any other key. The
 * sign-in was granted `grantedScopes` (`system/*.cruds` unless given), and
 * the FHIR server answers from `fhirAnswers`.
 */
const renderChat = ({
  replies = [],
  keptKey = Option.none(),
  storage = memoryStorage(),
  grantedScopes = ['system/*.cruds'],
  fhirAnswers = {},
}: {
  readonly replies?: readonly HeldReply[]
  readonly keptKey?: Option.Option<string>
  readonly storage?: MemoryStorage
  readonly grantedScopes?: readonly string[]
  readonly fhirAnswers?: StubAnswers
} = {}): RenderedChat => {
  Option.map(keptKey, (key) =>
    Effect.runSync(storage.local.set(ApiKey.STORAGE_KEY, JSON.stringify(key)))
  )
  const claude = stubClaude({ models: LISTED_MODELS, replies })
  const rejecting = stubClaude({
    modelsThrow: new AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()),
  })
  const environment: AssistantEnvironment = {
    storage: storage.layer,
    claudeLayerFor: (apiKey) =>
      Redacted.value(apiKey) === GOOD_KEY ? claude.layer : rejecting.layer,
  }
  const fhir = stubSmartRuntime(fhirAnswers)
  const rendered = render(
    createElement(AssistantChat, {
      fhirBaseUrl: PLACE.fhirBaseUrl,
      patient: PLACE.patient,
      grantedScopes: grantedScopes.map(Scope.parse),
      runSmart: fhir.runtime.runSmart,
      environment,
    })
  )
  return { rendered, storage, claude, fhir }
}

/** The chat kept at {@link PLACE} in `storage`; `None` when there is none. */
const keptChatIn = (storage: MemoryStorage): Option.Option<Chat.Type> =>
  Effect.runSync(Chat.read(PLACE).pipe(Effect.provide(Layer.provide(Chat.layer, storage.layer))))

/** Keep `chat` at {@link PLACE} in `storage`. */
const keepChatIn = (storage: MemoryStorage, chat: Chat.Type): void => {
  Effect.runSync(
    Chat.write(PLACE, chat).pipe(Effect.provide(Layer.provide(Chat.layer, storage.layer)))
  )
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

export { GOOD_KEY, keepChatIn, keptChatIn, PLACE, renderChat, stubDialogMethods }
export type { RenderedChat }
