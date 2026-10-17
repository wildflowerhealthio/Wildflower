import type { QueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import type { SmartHandshake } from '@wildflowerhealthio/fhir-r4-react/smart'
import { useSubscribable } from '@wildflowerhealthio/react-kitchen-sink'

import type { PageState, PageStore } from './page-state.ts'

/** The SMART client a completed handshake hands the app. */
type SmartClient = Extract<SmartHandshake, { readonly kind: 'ready' }>['client']

/**
 * What every route reads from the router, fixed for the visit: the page's
 * query cache, the SMART client the handshake completed with, and the page's
 * choices.
 */
interface RouterContext {
  /** The page's one query cache, which the handshake ran on too. */
  readonly queryClient: QueryClient
  /** The client the completed SMART handshake handed the app. */
  readonly client: SmartClient
  /** The reader's choices that more than one tab reads. */
  readonly pageStore: PageStore
}

/** The SMART client the handshake completed with. */
const useSmartClient = (): SmartClient =>
  useRouteContext({ from: '__root__', select: (context) => context.client })

/**
 * The part of the page's {@link PageState} `select` picks, kept current, and
 * how to change the state.
 */
const usePageState = <A>(select: (state: PageState) => A): readonly [A, PageStore['update']] => {
  const pageStore = useRouteContext({ from: '__root__', select: (context) => context.pageStore })
  return [select(useSubscribable(pageStore.subscribable)), pageStore.update]
}

export { usePageState, useSmartClient }
export type { RouterContext, SmartClient }
