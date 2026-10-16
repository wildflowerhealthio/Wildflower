import { QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRouter,
  RouterProvider,
  type RouterHistory,
} from '@tanstack/react-router'
import { useState, type JSX } from 'react'

import { BaseGate, type BaseGateProps } from '../base-gate.tsx'
import { make, type RouterContextInputs } from '../router-context.ts'
import { routeTree } from '../routeTree.gen.ts'

/** Props for {@link BaseUnderTest}. */
type BaseUnderTestProps = Omit<BaseGateProps, 'children'> &
  RouterContextInputs & {
    /** The path the router starts at, on a memory history of its own. */
    readonly path: string
    /** The history the router navigates in place of one starting at `path`, for a test to move through. */
    readonly history?: RouterHistory
  }

/**
 * The base as the host app composes it: its gate around a router over its
 * routes, under the package-local root, at `path` on a memory
 * history, or on `history`, with the query cache `ServersRouterContext.make`
 * builds.
 */
function BaseUnderTest({ path, history, ...props }: BaseUnderTestProps): JSX.Element {
  const [context] = useState(() => make(props))
  const [router] = useState(() =>
    createRouter({
      routeTree,
      history: history ?? createMemoryHistory({ initialEntries: [path] }),
      context,
    })
  )
  return (
    <BaseGate {...props}>
      <QueryClientProvider client={context.queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </BaseGate>
  )
}

export { BaseUnderTest, type BaseUnderTestProps }
