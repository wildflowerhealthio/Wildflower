import type { HttpClient } from '@effect/platform'
import { cleanup, render, type RenderResult } from '@testing-library/react'
import { WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY } from '@wildflowerhealthio/branding-core'
import type { HostPlatform, TauriInvoke } from '@wildflowerhealthio/servers-core-js'
import {
  type ConsentStorage,
  type TelemetryConsent,
  writeConsent,
} from '@wildflowerhealthio/telemetry-core'
import type * as TelemetryWeb from '@wildflowerhealthio/telemetry-web'
import type { Context, Layer } from 'effect'
import { createElement } from 'react'
import { afterEach, beforeEach, vi } from 'vite-plus/test'

import { BaseUnderTest } from './base-under-test.tsx'
import { type FakeEvents, type FakeTaps, fakeEvents, fakeHealth, fakeTaps } from './host-fakes.ts'

// Starting the SDK is the collaborator whose every touch the gate controls, so
// the module boundary is where it is stubbed; the rest stays real. The mock is
// hoisted above this module's imports, so it is in place before the base's
// modules first load `telemetry-web`.
const { initConsentedTelemetryMock, redactServerHostMock } = vi.hoisted(() => ({
  initConsentedTelemetryMock: vi.fn<typeof TelemetryWeb.initConsentedTelemetry>(() => false),
  redactServerHostMock: vi.fn<typeof TelemetryWeb.redactServerHost>(),
}))
vi.mock('@wildflowerhealthio/telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: initConsentedTelemetryMock,
  redactServerHost: redactServerHostMock,
}))

/** The DSN {@link renderBase} hands the base's telemetry. */
const BASE_DSN = 'https://key@sentry.example/12'

/** A `ConsentStorage` kept in a `Map`, standing in for the webview's `localStorage`. */
const mapConsentStorage = (): ConsentStorage => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    },
  }
}

/** A storage holding a current answer, as a returning user's has. */
const storageAnswered = (
  switches: Pick<TelemetryConsent, 'crashReports' | 'performance'>
): ConsentStorage => {
  const storage = mapConsentStorage()
  writeConsent(storage, {
    version: WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY.version,
    decidedAt: '2026-10-06T12:00:00.000Z',
    ...switches,
  })
  return storage
}

/** The start config the host app passes the background service. */
const BACKGROUND_SERVICE_START_CONFIG = {
  serviceLabel: 'Wildflower server is running',
  foregroundServiceType: 'shortService',
} as const

/**
 * The launcher the app passes as the host's default: the golden file's first
 * server has it, its second doesn't.
 */
const DEFAULT_LAUNCHER_URL = 'https://launcher.wildflowerhealth.io/'

/**
 * The Authorization app the app passes as the host's default: the golden
 * file's first server has it, its second doesn't.
 */
const DEFAULT_AUTHORIZATION_URL = 'https://authorization.wildflowerhealth.io/'

/**
 * Render the base as the host app composes it, at `path`, over `invoke` and
 * `storage`, with `/health` answered by `httpClient` (passing by default).
 */
const renderBase = ({
  invoke,
  storage,
  path = '/servers',
  platform = 'desktop',
  events = fakeEvents(),
  taps = fakeTaps(),
  httpClient = fakeHealth(() => Response.json({ status: 'pass' })).layer,
}: {
  readonly invoke: Context.Tag.Service<TauriInvoke>
  readonly storage: ConsentStorage
  readonly path?: string
  readonly platform?: HostPlatform.Type
  readonly events?: FakeEvents
  readonly taps?: FakeTaps
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>
}): RenderResult =>
  render(
    createElement(BaseUnderTest, {
      invoke,
      platform,
      listen: events.listen,
      listenToNotificationTaps: taps.listen,
      backgroundServiceStartConfig: BACKGROUND_SERVICE_START_CONFIG,
      defaultLauncherUrl: DEFAULT_LAUNCHER_URL,
      defaultAuthorizationUrl: DEFAULT_AUTHORIZATION_URL,
      telemetry: { dsn: BASE_DSN, app: 'host-app' },
      httpClient,
      path,
      storage,
    })
  )

/**
 * jsdom has no native `<dialog>`: `showModal` and `close` are modelled as the
 * `open` attribute, and the original descriptors are put back after each test.
 */
const dialogMethodDescriptors = (['showModal', 'close'] as const).map(
  (method) =>
    [method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)] as const
)

/**
 * A `ResizeObserver` that never fires: jsdom has no layout, and nothing these
 * tests check hangs on a resize (the server page's `RouteTabs` observes its
 * strip).
 */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** `HTMLDialogElement.showModal` as jsdom lacks it: the dialog gains `open`. */
function showModalAsOpen(this: HTMLDialogElement): void {
  this.setAttribute('open', '')
}

/** `HTMLDialogElement.close` as jsdom lacks it: the dialog loses `open`, and fires `close`. */
function closeAsNotOpen(this: HTMLDialogElement): void {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

/** `Element.scrollTo` as it was before each test, which jsdom leaves undefined. */
const scrollToDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTo')

/**
 * Register, for each test of the calling file, the browser APIs the base
 * needs that jsdom lacks (`<dialog>`, `ResizeObserver`, `matchMedia`,
 * `Element.scrollTo`), and afterwards unmount, put them back, and reset the
 * telemetry mocks. Call it once at the top level of a file that renders the
 * base.
 */
const setUpEachBaseTest = (): void => {
  beforeEach(() => {
    // `RouteTabs` scrolls its strip to the current tab, and asks whether
    // motion is reduced, through APIs jsdom lacks.
    vi.stubGlobal('ResizeObserver', InertResizeObserver)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    Element.prototype.scrollTo = () => {}
    HTMLDialogElement.prototype.showModal = showModalAsOpen
    HTMLDialogElement.prototype.close = closeAsNotOpen
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (scrollToDescriptor === undefined) Reflect.deleteProperty(Element.prototype, 'scrollTo')
    else Object.defineProperty(Element.prototype, 'scrollTo', scrollToDescriptor)
    initConsentedTelemetryMock.mockClear()
    redactServerHostMock.mockReset()
    for (const [method, descriptor] of dialogMethodDescriptors) {
      if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
      else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
    }
  })
}

/** The open `<dialog>`, the consent one or a confirm, or `null`. */
const openDialog = (): HTMLDialogElement | null => document.querySelector('dialog[open]')

/** The `<dialog>` that is open. */
const openDialogOrThrow = (): HTMLDialogElement => {
  const dialog = openDialog()
  if (dialog === null) throw new Error('no dialog is open')
  return dialog
}

/** The text of each paragraph in `container` outside a closed or open dialog. */
const paragraphsOf = (container: HTMLElement): readonly (string | null)[] =>
  Array.from(container.querySelectorAll('p'))
    .filter((paragraph) => paragraph.closest('dialog') === null)
    .map((paragraph) => paragraph.textContent)

export {
  BACKGROUND_SERVICE_START_CONFIG,
  BASE_DSN,
  DEFAULT_AUTHORIZATION_URL,
  DEFAULT_LAUNCHER_URL,
  initConsentedTelemetryMock,
  mapConsentStorage,
  openDialog,
  openDialogOrThrow,
  paragraphsOf,
  redactServerHostMock,
  renderBase,
  setUpEachBaseTest,
  storageAnswered,
}
