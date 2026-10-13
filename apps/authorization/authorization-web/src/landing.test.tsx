import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { Landing, type LandingSignIn } from './landing.tsx'
import { NOT_A_WILDFLOWER_SERVER, type SignInProblem, type SignInStep } from './sign-in.ts'

afterEach(() => {
  cleanup()
})

describe('Landing', () => {
  it('signs in straight away to the server ?iss= names', async () => {
    // Arrange — a server's `management_endpoint`, or a bookmark of it.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Ok', value: `${SERVER_URL}/oauth/authorize?x=1` })
    )

    // Act
    mountLanding({ arrivalServerUrl: SERVER_URL, signIn })

    // Assert
    await waitFor(() => {
      expect(signIn.left).toEqual([`${SERVER_URL}/oauth/authorize?x=1`])
    })
    expect(signIn.started).toEqual([SERVER_URL])
  })

  it('offers the connect menu with no ?iss=, and a pick sets ?iss= and signs in', async () => {
    // Arrange — a bare visit to `https://wildflowerhealth.io/authorization/`.
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Ok', value: `${SERVER_URL}/oauth/authorize?x=1` })
    )
    mountLanding({ arrivalServerUrl: undefined, signIn })
    expect(signIn.started).toEqual([])

    // Act — the reader types the server's address.
    const freeEntry = within(await screen.findByRole('form', { name: 'Another Wildflower server' }))
    fireEvent.change(freeEntry.getByLabelText('Server URL'), { target: { value: SERVER_URL } })
    fireEvent.click(freeEntry.getByRole('button', { name: 'Connect' }))

    // Assert
    await waitFor(() => {
      expect(signIn.left).toEqual([`${SERVER_URL}/oauth/authorize?x=1`])
    })
    expect(signIn.remembered).toEqual([SERVER_URL])
    expect(signIn.started).toEqual([SERVER_URL])
  })

  it('says so when the server isn’t a Wildflower server', async () => {
    // Arrange
    const signIn = recordingSignIn(() =>
      Promise.resolve({ tag: 'Failed', reason: NOT_A_WILDFLOWER_SERVER })
    )

    // Act
    mountLanding({ arrivalServerUrl: SERVER_URL, signIn })

    // Assert
    expect(await screen.findByText(/This isn't a Wildflower server\./)).toBeTruthy()
    expect(signIn.left).toEqual([])
  })

  it('shows why the last sign-in failed, and does not retry it on arrival', async () => {
    // Arrange
    const signIn = recordingSignIn(() => new Promise(() => {}))

    // Act
    mountLanding({
      arrivalServerUrl: SERVER_URL,
      signIn,
      bootSignInProblem: { reason: 'The authorization request was denied.', serverUrl: SERVER_URL },
    })

    // Assert
    expect(await screen.findByText(/was denied/)).toBeTruthy()
    expect(signIn.started).toEqual([])
  })
})

// Helpers

const SERVER_URL = 'https://ruth.wildflowerhealth.io'

/** A {@link LandingSignIn} that records what it was asked to do. */
const recordingSignIn = (
  start: () => Promise<SignInStep<string>>
): LandingSignIn & {
  readonly started: string[]
  readonly remembered: string[]
  readonly left: string[]
} => {
  const started: string[] = []
  const remembered: string[] = []
  const left: string[] = []
  return {
    started,
    remembered,
    left,
    start: (serverUrl) => {
      started.push(serverUrl)
      return start()
    },
    rememberServer: (serverUrl) => {
      remembered.push(serverUrl)
    },
    leave: (authorizationUrl) => {
      left.push(authorizationUrl)
    },
  }
}

const mountLanding = (props: {
  readonly arrivalServerUrl: string | undefined
  readonly signIn: LandingSignIn
  readonly bootSignInProblem?: SignInProblem
}): void => {
  render(
    <Landing
      arrivalServerUrl={props.arrivalServerUrl}
      bootSignInProblem={props.bootSignInProblem}
      pageIsSecure
      signIn={props.signIn}
    />
  )
}
