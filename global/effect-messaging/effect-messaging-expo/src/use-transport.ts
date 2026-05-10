import { Effect, Exit, Scope } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import { useEffect, useMemo } from 'react'
import { type ExpoTransport, type ExpoTransportLayers, makeExpoTransport } from './transport.ts'

/**
 * Inputs the hook hands to {@link makeExpoTransport}. Identical to
 * the underlying config; re-exported here so callers don't have to
 * cross-import from `./transport.ts` to type their factory.
 */
interface UseTransportConfig<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly bridges: Bridges
  readonly layers: ExpoTransportLayers<Bridges>
  readonly initialMessages: ReadonlyArray<Bridge.SendableMessage<Bridges, 'Host'>>
  readonly baseUrl: string
  readonly webviewHandleRef: { readonly current: { postMessage(message: string): void } | null }
}

/**
 * React hook that owns an {@link ExpoTransport} lifecycle: builds it
 * via {@link makeExpoTransport} when `factory` changes, scoped so
 * the dispatch fiber and queue tear down on unmount or rebuild.
 *
 * Returns `null` until the transport is built, then the live
 * transport. Callers MUST memoize `factory` (e.g. with `useCallback`
 * keyed on `route`, `token`, etc.) — every new factory reference
 * rebuilds the transport.
 *
 * @example
 * ```tsx
 * const webviewHandleRef = useRef<WebViewHandle | null>(null)
 * const [canGoBack, setCanGoBack] = useState(false)
 * const factory = useCallback(
 *   () => ({
 *     bridges: [NavigationBridge] as const,
 *     layers: [
 *       NavigationBridge.Host.ReceiverLayer({
 *         RouteChanged: ({ canGoBack: cgb }) => Effect.sync(() => setCanGoBack(cgb)),
 *       }),
 *     ] as const,
 *     initialMessages: [{ _tag: 'HostRequestedWebNavigation', path: route }],
 *     webviewHandleRef,
 *   }),
 *   [route, webviewHandleRef]
 * )
 * const transport = useTransport(factory)
 * ```
 */
const useTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  config: UseTransportConfig<Bridges>
): ExpoTransport<Bridges> => {
  const [transport, scope] = useMemo(() => {
    const builtScope = Effect.runSync(Scope.make())
    const builtTransport = Effect.runSync(Scope.extend(makeExpoTransport(config), builtScope))
    return [builtTransport, builtScope] as const
  }, [config])

  useEffect(() => {
    const currentScope = scope
    return (): void => {
      Effect.runSync(Scope.close(currentScope, Exit.void))
    }
  }, [scope])

  return transport
}

export { useTransport }
export type { UseTransportConfig }
