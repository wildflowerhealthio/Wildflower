import { type JSX, useEffect, useRef } from 'react'
import { NavigationType, useLocation, useNavigate, useNavigationType } from 'react-router'

type ReactNativeWebView = { postMessage: (data: string) => void }
type WebViewWindow = typeof window & { ReactNativeWebView?: ReactNativeWebView }

const post = (payload: object): void => {
  const win: WebViewWindow = window
  win.ReactNativeWebView?.postMessage(JSON.stringify(payload))
}

/**
 * Bridges router state to the React Native host:
 * - posts `host:route` with `canGoBack` whenever the route changes, so the
 *   native screen header can show a back chevron
 * - posts `host:ready` once on mount so the native loader can fade out
 * - listens for `host:back` from the host and calls `navigate(-1)`
 */
function HostBridge(): JSX.Element | null {
  const location = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const depthRef = useRef(0)

  useEffect(() => {
    if (navigationType === NavigationType.Push) depthRef.current += 1
    else if (navigationType === NavigationType.Pop)
      depthRef.current = Math.max(0, depthRef.current - 1)
    post({ type: 'host:route', canGoBack: depthRef.current > 0, pathname: location.pathname })
  }, [location.key, location.pathname, navigationType])

  useEffect(() => {
    post({ type: 'host:ready' })
  }, [])

  useEffect(() => {
    const handler = (event: MessageEvent<unknown>): void => {
      const data = event.data
      if (typeof data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(data)
      } catch {
        return
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        Reflect.get(parsed, 'type') === 'host:back'
      ) {
        void navigate(-1)
      }
    }
    window.addEventListener('message', handler)
    return (): void => {
      window.removeEventListener('message', handler)
    }
  }, [navigate])

  return null
}

export { HostBridge }
