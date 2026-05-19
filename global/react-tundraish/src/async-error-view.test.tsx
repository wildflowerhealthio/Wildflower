import { render, screen, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import { Await, createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { AsyncErrorView } from './async-error-view.tsx'

afterEach(() => {
  document.body.innerHTML = ''
})

const renderWithRejectedAwait = (
  reason: unknown,
  errorElement: React.ReactNode
): ReturnType<typeof render> => {
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <Suspense fallback={<p>loading</p>}>
          <Await resolve={Promise.reject(reason)} errorElement={errorElement}>
            {() => <p>resolved</p>}
          </Await>
        </Suspense>
      ),
    },
  ])
  return render(<RouterProvider router={router} />)
}

describe('AsyncErrorView', () => {
  it('renders the rejected reason via PageError when used as <Await errorElement>', async () => {
    // Arrange
    // Act
    renderWithRejectedAwait(new Error('fetch failed'), <AsyncErrorView title="Not Found" />)

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Not Found' })).toBeTruthy()
    })
    expect(screen.getByText('fetch failed')).toBeTruthy()
  }, 15_000)

  it('renders without a heading when no title prop is given', async () => {
    // Arrange
    // Act
    renderWithRejectedAwait('boom', <AsyncErrorView />)

    // Assert
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeTruthy()
    })
    expect(screen.queryByRole('heading')).toBeNull()
  })
})
