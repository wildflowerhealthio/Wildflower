import { cleanup, render, waitFor } from '@testing-library/react'
import { Either } from 'effect'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { LaunchOutcome } from './-launch.ts'
import { LaunchScreen } from './launch.$id.tsx'

describe('LaunchScreen', () => {
  afterEach(() => {
    cleanup()
  })

  it('should launch the app named in the route once, and stay while the tab moves to it', async () => {
    // Arrange — a forwarded launch: `launch` has already sent the tab on.
    const run = recordingRun(Either.right('navigated'))

    // Act
    const { rerender } = render(<LaunchScreen id="patient-browser" {...run.props} />)
    rerender(<LaunchScreen id="patient-browser" {...run.props} />)

    // Assert — one launch despite the re-render, and no bounce home.
    await waitFor(() => {
      expect(run.launched).toEqual(['patient-browser'])
    })
    expect(run.wentHome).toEqual([])
  })

  it('should go home when the host opened the app natively', async () => {
    const run = recordingRun(Either.right('openedOnHost'))

    render(<LaunchScreen id="patient-browser" {...run.props} />)

    await waitFor(() => {
      expect(run.wentHome).toEqual([undefined])
    })
  })

  it('should go home carrying the failure for the banner', async () => {
    const run = recordingRun(Either.left('eyJlcnJvciI6IkFwcE5vdEZvdW5kIn0'))

    render(<LaunchScreen id="patient-browser" {...run.props} />)

    await waitFor(() => {
      expect(run.wentHome).toEqual(['eyJlcnJvciI6IkFwcE5vdEZvdW5kIn0'])
    })
  })
})

// Helpers

/** `LaunchScreen`'s `launch` and `goHome`, answering `result` and recording each call. */
const recordingRun = (
  result: Either.Either<LaunchOutcome, string>
): {
  readonly props: {
    readonly launch: (id: string) => Promise<Either.Either<LaunchOutcome, string>>
    readonly goHome: (launchError: string | undefined) => void
  }
  readonly launched: string[]
  readonly wentHome: (string | undefined)[]
} => {
  const launched: string[] = []
  const wentHome: (string | undefined)[] = []
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
