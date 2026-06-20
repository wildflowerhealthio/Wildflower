import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import type { JSX } from 'react'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

import { DatabasesView } from './databases-view.tsx'
import { describeDatabase, humanizeBytes } from './format.ts'
import type { DatabaseMetadata } from './queries.ts'

const health: DatabaseMetadata = {
  id: 'health-data.sqlite',
  label: 'Health data',
  description: 'Your FHIR clinical records.',
  exists: true,
  sizeBytes: 1536,
  tableCount: 7,
  modifiedAt: '2026-06-20T00:00:00.000Z',
}
const wildflower: DatabaseMetadata = {
  id: 'wildflower.sqlite',
  label: 'Wildflower app data',
  description: 'App state.',
  exists: false,
  sizeBytes: 0,
}

const noop = (): void => {}

// `DatabasesView`'s `PageHeader` back-link renders a TanStack `<Link>`, so it
// must mount inside a router. Mirrors `RelaySettingsEntry.test.tsx`.
const renderView = (props: Parameters<typeof DatabasesView>[0]): void => {
  const rootRoute = createRootRoute({ component: (): JSX.Element => <DatabasesView {...props} /> })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
}

afterEach(() => {
  cleanup()
})

describe('humanizeBytes', () => {
  test('formats bytes, KB, and MB', () => {
    expect(humanizeBytes(512)).toBe('512 B')
    expect(humanizeBytes(1536)).toBe('1.5 KB')
    expect(humanizeBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('describeDatabase', () => {
  test('shows table count for an existing database', () => {
    expect(describeDatabase(health)).toContain('7 tables')
  })

  test('marks an absent database as not created yet', () => {
    expect(describeDatabase(wildflower)).toBe('App state. · Not created yet')
  })
})

describe('DatabasesView', () => {
  test('renders one row per database with its size as metadata', async () => {
    renderView({
      databases: [health, wildflower],
      onExport: noop,
      onDelete: noop,
      exportingId: null,
      deletingId: null,
      errorMessage: null,
    })
    await waitFor(() => expect(screen.getByText('Health data')).toBeTruthy())
    expect(screen.getByText('Wildflower app data')).toBeTruthy()
    // Size metadata for the existing db; "Empty" for the absent one.
    expect(screen.getByText('1.5 KB')).toBeTruthy()
    expect(screen.getByText('Empty')).toBeTruthy()
  })

  test('download fires onExport for an existing database', async () => {
    const onExport = vi.fn()
    renderView({
      databases: [health],
      onExport,
      onDelete: noop,
      exportingId: null,
      deletingId: null,
      errorMessage: null,
    })
    const download = await screen.findByRole('button', { name: 'Download' })
    download.click()
    expect(onExport).toHaveBeenCalledWith('health-data.sqlite')
  })

  test('an absent database disables both actions (nothing to download or delete)', async () => {
    renderView({
      databases: [wildflower],
      onExport: noop,
      onDelete: noop,
      exportingId: null,
      deletingId: null,
      errorMessage: null,
    })
    const download = await screen.findByRole('button', { name: 'Download' })
    const remove = screen.getByRole('button', { name: 'Delete' })
    expect(download.hasAttribute('disabled')).toBe(true)
    expect(remove.hasAttribute('disabled')).toBe(true)
  })

  test('surfaces a mutation error message', async () => {
    renderView({
      databases: [health],
      onExport: noop,
      onDelete: noop,
      exportingId: null,
      deletingId: null,
      errorMessage: 'export failed',
    })
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('export failed')).toBeTruthy()
  })
})
