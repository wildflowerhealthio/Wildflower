import { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { routeTree } from './routeTree.gen.ts'

describe('background-server-service routes', () => {
  it('should expose the server page at /settings/server/ and nothing else', () => {
    // Arrange
    const router = createRouter({
      routeTree,
      context: {
        queryClient: new QueryClient(),
        runAuthed: () => Promise.reject(new Error('runAuthed not used in route tests')),
        runtimeLayer: Layer.die('runtimeLayer not used in route tests'),
        awaitAuthReady: () => Promise.resolve(),
      },
    })

    // Act
    const routes = Object.values(router.routesById).filter((route) => route.id !== '__root__')

    // Assert — the app mounts this directory under its own `/settings`.
    expect(routes.map((route) => [route.id, route.fullPath])).toEqual([
      ['/settings/server/', '/settings/server/'],
    ])
  })
})
