/* oxlint-disable react/only-export-components -- this factory module
   intentionally exports a builder that returns a `Provider` component;
   the rest of the file's exports are types and a non-component factory,
   so fast-refresh's per-file rule doesn't model the pattern. */
import type { Bridge, BridgeTransport } from 'effect-messaging-core'
import type { FC as ReactFC, JSX } from 'react'

import { makeMessageSenderPipe } from './make-message-sender-pipe.tsx'

interface MadeNamedPipe<
  TName extends string,
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  /**
   * Renders the pipe's context. Its `displayName` is `${TName}PipeProvider`,
   * so it shows up under that friendly tag in React DevTools.
   */
  readonly Provider: ReactFC<{ children: React.ReactNode }> & {
    displayName: `${TName}PipeProvider`
  }
  /**
   * Register a typed sender as the active downstream for this pipe — the
   * named analogue of {@link MadeMessageSenderPipe.useAsPipeMessageSender}.
   */
  readonly useAsSource: (sender: BridgeTransport.MessageSender<TBridges, TSide>) => void
  /**
   * Get the typed sender for this pipe — the named analogue of
   * {@link MadeMessageSenderPipe.usePipeMessageSender}. The returned
   * function is identity-stable for the lifetime of the surrounding
   * Provider — safe to include in `useEffect` / `useMemo` deps.
   */
  readonly useSender: () => BridgeTransport.MessageSender<TBridges, TSide>
  /**
   * Returns the underlying RefObject holding the active sender.
   * Identity-stable across renders. Initially points at
   * {@link MadeNamedPipe.defaultSender} (the pipe's built-in
   * warn-and-drop) and is updated by {@link MadeNamedPipe.useAsSource}
   * when a sender is registered.
   *
   * Direct mutation of `.current` is a supported pattern — reach for
   * it when the registration site cannot run inside a `useEffect`
   * (e.g. capturing a transport sender from inside an
   * `onTransportReady` `Effect.sync` callback). The named analogue of
   * {@link MadeMessageSenderPipe.usePipeMessageSenderRef}.
   */
  readonly useSenderRef: () => React.RefObject<BridgeTransport.MessageSender<TBridges, TSide>>
  /**
   * The pipe's built-in warn-and-drop sender — the named analogue of
   * {@link MadeMessageSenderPipe.defaultSender}.
   */
  readonly defaultSender: BridgeTransport.MessageSender<TBridges, TSide>
}

/**
 * Friendly-named wrapper around {@link makeMessageSenderPipe}.
 *
 * Each call returns a `{ Provider, useAsSource, useSender }` trio where
 * `Provider.displayName` is `${TName}PipeProvider` (instead of the
 * underlying `${TName}MessageSenderPipeContext`), and the hook keys drop
 * the `Pipe` / `Message` boilerplate so consumers can write:
 *
 * ```ts
 * const { Provider, useAsSource, useSender } = makeNamedPipe(
 *   'BrowserSniffer',
 *   [BrowserSnifferBridge] as const,
 *   'Host'
 * )
 * export const {
 *   Provider: MessageSenderToBrowserSnifferProvider,
 *   useAsSource: useAsMessageSenderToBrowserSniffer,
 *   useSender: useMessageSenderToBrowserSniffer,
 * } = pipe
 * ```
 *
 * Behaviour is delegated 1:1 to {@link makeMessageSenderPipe}; this only
 * renames the surface area.
 */
const makeNamedPipe = <
  const TName extends string,
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  name: TName,
  bridges: TBridges,
  side: TSide
): MadeNamedPipe<TName, TBridges, TSide> => {
  const {
    Provider: InnerProvider,
    useAsPipeMessageSender,
    usePipeMessageSender,
    usePipeMessageSenderRef,
    defaultSender,
  } = makeMessageSenderPipe(name, bridges, side)

  // Wrap the inner provider so we can give it a friendlier displayName
  // without losing the type-witness chain. The wrapper is a passthrough —
  // identity / behavior comes from `InnerProvider`. Captures `InnerProvider`
  // from the enclosing factory call, so each `makeNamedPipe` call returns
  // its own provider tied to its own context.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const Provider = ({ children }: { children: React.ReactNode }): JSX.Element => (
    <InnerProvider>{children}</InnerProvider>
  )
  Provider.displayName = `${name}PipeProvider`

  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    Provider: Provider as ReactFC<{ children: React.ReactNode }> & {
      displayName: `${TName}PipeProvider`
    },
    useSenderRef: usePipeMessageSenderRef,
    useAsSource: useAsPipeMessageSender,
    useSender: usePipeMessageSender,
    defaultSender,
  }
}

export { makeNamedPipe }
export type { MadeNamedPipe }
