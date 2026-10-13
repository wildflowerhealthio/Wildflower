import { cleanup, render, waitFor } from '@testing-library/react'
import { Either } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { LaunchScreen } from './launch.$id.tsx'

describe('LaunchScreen', () => {
  afterEach(() => {
    cleanup()
  })

  it('should launch the app named in the route once, and stay while the tab moves to it', async () => {
    // Arrange — `launch` has already sent the tab on.
    const run = recordingRun(Either.void)

    // Act
    const { rerender } = render(<LaunchScreen id="medications" {...run.props} />)
    rerender(<LaunchScreen id="medications" {...run.props} />)

    // Assert — one launch despite the re-render, and no bounce home.
    await waitFor(() => {
      expect(run.launched).toEqual(['medications'])
    })
    expect(run.wentHome).toEqual([])
  })

  it('should go home carrying the failure for the banner', async () => {
    const run = recordingRun(Either.left('eyJlcnJvciI6IkFwcE5vdEZvdW5kIn0'))

    render(<LaunchScreen id="medications" {...run.props} />)

    await waitFor(() => {
      expect(run.wentHome).toEqual(['eyJlcnJvciI6IkFwcE5vdEZvdW5kIn0'])
    })
  })
})

// Helpers

/** `LaunchScreen`'s `launch` and `goHome`, answering `result` and recording each call. */
const recordingRun = (
  result: Either.Either<void, string>
): {
  readonly props: {
    readonly launch: (id: string) => Promise<Either.Either<void, string>>
    readonly goHome: (launchError: string) => void
  }
  readonly launched: string[]
  readonly wentHome: string[]
} => {
  const launched: string[] = []
  const wentHome: string[] = []
  return {
    launched,
    wentHome,
    props: {
      launch: (id) => {
        launched.push(id)
        return Promise.resolve(result)
      },
      goHome: (launchError) => {
        wentHome.push(launchError)
      },
    },
  }
}
