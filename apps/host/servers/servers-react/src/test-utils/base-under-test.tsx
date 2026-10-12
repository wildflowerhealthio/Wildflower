import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { useState, type JSX } from 'react'

import { BaseGate, type BaseGateProps } from '../base-gate.tsx'
import { make, type RouterContextInputs } from '../router-context.ts'
import { routeTree } from '../routeTree.gen.ts'

/** Props for {@link BaseUnderTest}. */
type BaseUnderTestProps = Omit<BaseGateProps, 'children'> &
  RouterContextInputs & {
    /** The path the router starts at. */
    readonly path: string
  }

/**
 * The base as the host app composes it: its gate around a router over its
 * routes, under the package-local root (`BaseLayout`), at `path` on a memory
 * history, with the query cache `ServersRouterContext.make` builds.
 */
function BaseUnderTest({ path, ...props }: BaseUnderTestProps): JSX.Element {
  const [context] = useState(() => make(props))
  const [router] = useState(() =>
    createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }), context })
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
