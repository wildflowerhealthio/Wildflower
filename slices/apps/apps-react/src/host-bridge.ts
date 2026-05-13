import { Either, Schema } from 'effect'

type ReactNativeWebView = { postMessage: (data: string) => void }

type WebViewWindow = typeof window & {
  ReactNativeWebView?: ReactNativeWebView
}

const RequestTunnelSchema = Schema.Struct({
  type: Schema.Literal('requestTunnel'),
})

const TunnelStartedResponseSchema = Schema.Struct({
  type: Schema.Literal('tunnelStarted'),
  origin: Schema.String,
})

const TunnelFailedResponseSchema = Schema.Struct({
  type: Schema.Literal('tunnelFailed'),
  reason: Schema.String,
})

const HostResponseSchema = Schema.Union(TunnelStartedResponseSchema, TunnelFailedResponseSchema)

type RequestTunnel = typeof RequestTunnelSchema.Type
type TunnelStartedResponse = typeof TunnelStartedResponseSchema.Type
type TunnelFailedResponse = typeof TunnelFailedResponseSchema.Type
type HostResponse = typeof HostResponseSchema.Type

const decodeHostResponse = Schema.decodeUnknownEither(HostResponseSchema)

const isWebView = (): boolean => {
  const win: WebViewWindow = window
  return win.ReactNativeWebView !== undefined
}

const notifyReady = (): void => {
  const win: WebViewWindow = window
  win.ReactNativeWebView?.postMessage(JSON.stringify({ type: 'host:ready' }))
}

const requestTunnel = (): Promise<HostResponse> =>
  new Promise((resolve, reject) => {
    const win: WebViewWindow = window
    const bridge = win.ReactNativeWebView
    if (bridge === undefined) {
      reject(new Error('host bridge not available'))
      return
    }
    const handler = (event: MessageEvent<unknown>): void => {
      const data = event.data
      if (typeof data !== 'string') {
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      const decoded = decodeHostResponse(parsed)
      if (Either.isRight(decoded)) {
        window.removeEventListener('message', handler)
        resolve(decoded.right)
      }
    }
    window.addEventListener('message', handler)
    const payload: RequestTunnel = { type: 'requestTunnel' }
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    bridge.postMessage(JSON.stringify(payload))
  })

export { isWebView, notifyReady, requestTunnel }
export type { HostResponse, RequestTunnel, TunnelStartedResponse, TunnelFailedResponse }
