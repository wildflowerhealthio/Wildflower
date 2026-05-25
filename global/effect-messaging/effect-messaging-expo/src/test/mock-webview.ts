/**
 * Shared `react-native-webview` mock for Jest test suites in this
 * package.
 *
 * @remarks
 * `jest.mock('react-native-webview', factory)` is hoisted to the top
 * of the test file by `babel-plugin-jest-hoist`. The hoist refuses to
 * reorder references to module-scoped identifiers unless they match
 * `/^mock/i`, so every export here keeps that prefix — including the
 * factory function the consumer passes into `jest.mock`.
 *
 * Consumers wire the helper in two steps:
 *
 * ```ts
 * import {
 *   mockWebViewModuleFactory,
 *   resetMockWebView,
 *   mockWebViewState,
 * } from './test/mock-webview.ts'
 *
 * jest.mock('react-native-webview', () => mockWebViewModuleFactory())
 *
 * beforeEach(() => {
 *   resetMockWebView()
 * })
 *
 * it('exercises the WebView', () => {
 *   // ...render...
 *   expect(mockWebViewState.props?.source).toEqual(...)
 *   expect(mockWebViewState.postMessageCalls).toEqual([...])
 * })
 * ```
 */
import type * as React from 'react'
import type * as RNType from 'react-native'

/**
 * Props the mocked `WebView` captures off the most recent render. Mirrors the
 * subset of `react-native-webview`'s prop surface that the transport-level
 * tests assert against — keep it intentionally narrow.
 */
type MockWebViewProps = {
  readonly source?: { html?: string; baseUrl?: string; uri?: string }
  readonly onMessage?: (event: { nativeEvent: { data: string } }) => void
  readonly onLoadEnd?: () => void
  readonly onShouldStartLoadWithRequest?: (req: { url: string }) => boolean
}

/**
 * Mutable holder for the mock's captures. A single object keeps both
 * Jest hoist happy (`mock` prefix) and test ergonomics simple (no
 * accessor function calls).
 */
const mockWebViewState: {
  props: MockWebViewProps | null
  postMessageCalls: string[]
} = {
  props: null,
  postMessageCalls: [],
}

/**
 * Reset the shared captures. Call from `beforeEach` so suites observe
 * fresh state per test.
 */
const resetMockWebView = (): void => {
  mockWebViewState.props = null
  mockWebViewState.postMessageCalls = []
}

/**
 * Build the module shape Jest installs as the mocked
 * `react-native-webview` export. Pass directly into the `jest.mock`
 * factory.
 *
 * @remarks
 * The factory deliberately calls `jest.requireActual('react')` and
 * `jest.requireActual('react-native')` so the mock renders inside the
 * same React instance the test tree uses. Importing them at the top
 * of this helper would defeat that.
 */
const mockWebViewModuleFactory = (): {
  WebView: React.ForwardRefExoticComponent<
    MockWebViewProps & React.RefAttributes<{ postMessage: (data: string) => void }>
  >
} => {
  const ReactInner = jest.requireActual<typeof React>('react')
  const RN = jest.requireActual<typeof RNType>('react-native')
  const WebView = ReactInner.forwardRef(function MockWebView(
    props: MockWebViewProps,
    ref: React.Ref<{ postMessage: (data: string) => void }>
  ): React.ReactElement {
    mockWebViewState.props = props
    ReactInner.useImperativeHandle(
      ref,
      () => ({
        postMessage: (data: string): void => {
          mockWebViewState.postMessageCalls.push(data)
        },
      }),
      []
    )
    return ReactInner.createElement(RN.View, { testID: 'webview' })
  })
  return { WebView }
}

export { mockWebViewModuleFactory, mockWebViewState, resetMockWebView }
export type { MockWebViewProps }
