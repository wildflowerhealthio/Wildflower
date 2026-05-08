import { Schema } from 'effect'
import {
  AuthTokenIssued,
  GatekeeperNativeToWeb,
  GatekeeperWebToNative,
} from 'gatekeeper-core/message-schemas'
import { AppNavigationRequested, InteropNativeToWeb, InteropWebToNative } from 'interop-core'
import { EmbeddedWebView, useMessageHandler } from 'interop-expo'
import { type JSX, useCallback, useEffect, useMemo, useState } from 'react'
import { html } from 'wildflower-react/embeddable-html'

interface GatekeeperWebViewProps {
  readonly baseUrl: string
  readonly route: string
  readonly token?: string
}

/**
 * Embedded gatekeeper SPA wrapped for the Expo host. Composes the
 * slice-neutral {@link InteropWebToNative} / {@link InteropNativeToWeb}
 * records with gatekeeper's own {@link GatekeeperNativeToWeb} so this
 * single WebView surface accepts every message both sides need.
 *
 * `route` and (optional) `token` ride the unified `__INITIAL_MESSAGES__`
 * channel as pre-encoded {@link AppNavigationRequested} and
 * {@link AuthTokenIssued} messages — the page-side handler replays them
 * before any subscriber registers, so the SPA mounts at the right route
 * with the bearer already in localStorage and no flicker.
 */
function GatekeeperWebView({ baseUrl, route, token }: GatekeeperWebViewProps): JSX.Element {
  const initialMessages = useMemo<ReadonlyArray<string>>(() => {
    const messages: string[] = [
      Schema.encodeSync(AppNavigationRequested)({
        _tag: 'AppNavigationRequested',
        path: route,
      }),
    ]
    if (token !== undefined) {
      messages.push(Schema.encodeSync(AuthTokenIssued)({ _tag: 'AuthTokenIssued', token }))
    }
    return messages
  }, [route, token])

  const receive = useMemo(() => ({ ...InteropWebToNative, ...GatekeeperWebToNative }), [])
  const send = useMemo(() => ({ ...InteropNativeToWeb, ...GatekeeperNativeToWeb }), [])

  const { handler, webviewHandleRef, injectedScript, onMessage } = useMessageHandler({
    receive,
    send,
    initialMessages,
  })

  // Drive the screen-header back chevron from the page-reported route
  // depth. Sending `NativeBackRequested` lets the page decide what
  // "back" means (the page typically pops its router; the native screen
  // stays mounted).
  const [canGoBack, setCanGoBack] = useState(false)
  useEffect(
    () =>
      handler.setMessageListener('RouteChanged', (message) => {
        setCanGoBack(message.canGoBack)
      }),
    [handler]
  )
  const onBackPress = useCallback((): void => {
    handler.sendMessage({ _tag: 'NativeBackRequested' })
  }, [handler])

  return (
    <EmbeddedWebView
      ref={webviewHandleRef}
      source={{ html, baseUrl }}
      injectedScript={injectedScript}
      onMessage={onMessage}
      canGoBack={canGoBack}
      onBackPress={onBackPress}
    />
  )
}

export { GatekeeperWebView }
export type { GatekeeperWebViewProps }
