import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, type AnyRoute } from '@tanstack/react-router'
import { Layer } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type { RunAuthed } from './queries/index.ts'
import { routeTree } from './routeTree.gen.ts'

// Structural-only checks; no loader runs, so the runner is unused.
const stubRunAuthed: RunAuthed = () =>
  Promise.reject(new Error('runAuthed not used in route tests'))
const router = createRouter({
  routeTree,
  context: {
    queryClient: new QueryClient(),
    runAuthed: stubRunAuthed,
    runtimeLayer: Layer.die('runtimeLayer not used in route tests'),
    awaitAuthReady: () => Promise.resolve(),
  },
})

const routes = (): readonly AnyRoute[] =>
  Object.values(router.routesById).filter((route) => route.id !== '__root__')

describe('request-log routes', () => {
  test('the generated tree exposes the requests page at /settings/requests', () => {
    const byId = new Map(routes().map((route) => [route.id, route]))
    expect([...byId.keys()]).toEqual(['/settings/requests'])
    expect(byId.get('/settings/requests')?.fullPath).toBe('/settings/requests')
  })

  test('the requests route decodes its filter from the search', async () => {
    const requestsMatch = async (
      search: string
    ): Promise<{ readonly search: unknown; readonly status: string } | undefined> => {
      const searchRouter = createRouter({
        routeTree,
        context: router.options.context,
        history: createMemoryHistory({ initialEntries: [`/settings/requests${search}`] }),
      })
      await searchRouter.load()
      return searchRouter.state.matches.find((m) => m.routeId === '/settings/requests')
    }

    expect(await requestsMatch('?client=lifting&address=203.0.113.9&auth=refused')).toMatchObject({
      status: 'success',
      search: { client: 'lifting', address: '203.0.113.9', auth: 'refused' },
    })
    expect(await requestsMatch('?auth=sometimes')).toMatchObject({ status: 'error' })
  })
})
