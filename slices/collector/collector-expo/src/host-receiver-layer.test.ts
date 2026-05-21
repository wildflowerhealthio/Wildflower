import type { Layer } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import { CollectorBridgeExpo } from './index.ts'

// Type-only tests don't execute the hook; importing `./index.ts`
// loads `collector-fundamentals/bridge` plus `browser-sniffer-expo`
// (via `CollectorModalScreen`). Stub everything heavy.
jest.mock('collector-fundamentals/bridge', () => ({
  __esModule: true,
  default: {
    Host: { ReceiverLayer: (): unknown => ({}) },
  },
}))
jest.mock('expo-router', () => ({
  useRouter: (): unknown => ({ push: jest.fn(), back: jest.fn() }),
}))
jest.mock('browser-sniffer-expo', () => ({ BrowserSnifferWebView: (): unknown => null }))
jest.mock('collector-react', () => ({
  useCollectorHostMessaging: (): unknown => ({
    send: (): void => undefined,
    sendEffect: (): unknown => undefined,
  }),
}))
jest.mock('expo-tundraish', () => ({
  Spacing: { s5: 16 },
  ThemedView: (): unknown => null,
  ThemedText: (): unknown => null,
}))

describe('CollectorBridgeExpo.useReceiverLayer', () => {
  it('returns a Layer providing the Collector host handler tag (no R)', () => {
    expectTypeOf(CollectorBridgeExpo.useReceiverLayer).returns.toEqualTypeOf<
      Layer.Layer<MessageHandler.TagId<'Collector', 'Host'>>
    >()
  })

  it('takes no arguments', () => {
    expectTypeOf(CollectorBridgeExpo.useReceiverLayer).parameters.toEqualTypeOf<[]>()
  })
})
