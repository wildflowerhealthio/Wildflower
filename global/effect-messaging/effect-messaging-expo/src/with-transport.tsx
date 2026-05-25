import { Effect, Exit, Scope } from 'effect'
import type { BareSenderService, Bridge } from 'effect-messaging-core'
import { useEffect, useMemo, type JSX, Suspense, use } from 'react'
import { Text } from 'react-native'
import { type ExpoTransport, type ExpoTransportLayers, makeExpoTransport } from './transport.ts'

/**
 * Inputs the hook hands to {@link makeExpoTransport}. Identical to
 * the underlying config; re-exported here so callers don't have to
 * cross-import from `./transport.ts` to type their factory.
 *
 * @deprecated likely removable
 */
interface UseTransportConfig<Bridges extends ReadonlyArray<Bridge.AnyBridge>> {
  readonly bridges: Bridges
  readonly layers: ExpoTransportLayers<Bridges>
  readonly initialMessages: ReadonlyArray<Bridge.UrlParamableMessage<Bridges>>
  readonly baseUrl: string
  readonly webviewHandleRef: { readonly current: BareSenderService | null }
  readonly children: (transport: ExpoTransport<Bridges>) => JSX.Element
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
 * const webviewHandleRef = useRef<BareSenderService | null>(null)
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
 *
 * @deprecated likely removable
 */
const WithTransport = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>(
  config: UseTransportConfig<Bridges>
): JSX.Element => {
  const [transport, scope] = useMemo(() => {
    const builtScope = Effect.runSync(Scope.make())
    const builtTransport = Effect.runPromise(Scope.extend(makeExpoTransport(config), builtScope))
    return [builtTransport, builtScope] as const
  }, [config])

  useEffect(() => {
    const currentScope = scope
    return (): void => {
      Effect.runSync(Scope.close(currentScope, Exit.void))
    }
  }, [scope])
  return (
    <Suspense fallback={<Text>Loading transport...</Text>}>
      <WithTransportInner transportPromise={transport}>{config.children}</WithTransportInner>
    </Suspense>
  )
}

/**
 *
 * @deprecated likely removable
 */
const WithTransportInner = <const Bridges extends ReadonlyArray<Bridge.AnyBridge>>({
  transportPromise,
  children,
}: {
  transportPromise: Promise<ExpoTransport<Bridges>>
  children: (transport: ExpoTransport<Bridges>) => JSX.Element
}): JSX.Element => {
  const transport = use(transportPromise)
  return <>{children(transport)}</>
}

export { WithTransport }
export type { UseTransportConfig }
