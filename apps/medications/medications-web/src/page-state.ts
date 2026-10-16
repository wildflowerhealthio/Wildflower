import type { Province } from '@wildflowerhealthio/medication-sponsorship-core-js'

/**
 * What the reader has chosen on the page that more than one tab reads, kept
 * across tab changes and patient changes for the visit.
 */
interface PageState {
  /**
   * Whether to keep reading the medication list until its last page lands:
   * set by "load them all", the chunk bar, the interactions gate, and
   * opening Interactions. Never unset; once the last page lands it is inert.
   */
  readonly everyPageRequested: boolean
  /**
   * Whether Interactions shows its report as pages arrive instead of waiting
   * behind its gate for the full list. Never unset.
   */
  readonly partialInteractionsShown: boolean
  /** The province Savings checks programs against. */
  readonly province: Province
}

/**
 * The page's {@link PageState}, one store for the visit, in the router
 * context, so each tab reads and sets the same choices and a tab change
 * keeps them.
 */
interface PageStore {
  /** The state as it is now. */
  readonly snapshot: () => PageState
  /** Change the fields `change` names, keeping the rest. */
  readonly update: (change: Partial<PageState>) => void
  /** Call `onChange` after every `update`, until unsubscribed. */
  readonly subscribe: (onChange: () => void) => () => void
}

/** A store opening on the whole list unrequested, the gate up, and Ontario. */
const makePageStore = (): PageStore => {
  let state: PageState = {
    everyPageRequested: false,
    partialInteractionsShown: false,
    province: 'ON',
  }
  const listeners = new Set<() => void>()
  return {
    snapshot: () => state,
    update: (change) => {
      state = { ...state, ...change }
      for (const listener of listeners) listener()
    },
    subscribe: (onChange) => {
      listeners.add(onChange)
      return () => {
        listeners.delete(onChange)
      }
    },
  }
}

export { makePageStore }
export type { PageState, PageStore }
