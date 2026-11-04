import { useRouteContext } from '@tanstack/react-router'
import type { SmartRouterContext } from '@wildflowerhealthio/fhir-r4-react/smart'
import { useSubscribable } from '@wildflowerhealthio/react-kitchen-sink'

import type { PageState, PageStore } from './page-state.ts'

/**
 * What every route reads from the router, fixed for the visit: the SMART
 * router context the handshake's runtime makes (the page's query cache, the
 * connection, and the runner reads go through), and the page's choices.
 */
interface RouterContext extends SmartRouterContext {
  /** The reader's choices that more than one tab reads. */
  readonly pageStore: PageStore
}

/**
 * The part of the page's {@link PageState} `select` picks, kept current, and
 * how to change the state.
 */
const usePageState = <A>(select: (state: PageState) => A): readonly [A, PageStore['update']] => {
  const pageStore = useRouteContext({ from: '__root__', select: (context) => context.pageStore })
  return [select(useSubscribable(pageStore.subscribable)), pageStore.update]
}

export { usePageState }
export type { RouterContext }
