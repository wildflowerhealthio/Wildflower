import type { SignInLanding } from '@wildflowerhealthio/fhir-r4-react/smart'
import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import { createContext } from 'react'

/**
 * The sign-in the app root landed on, which `SmartAppRoot` provides to the
 * app on a sign-in's return and `SmartHandshakeGate` completes.
 */
const SignInLandingContext = createContext<SignInLanding | null>(null)
SignInLandingContext.displayName = 'SignInLandingContext'

/** The {@link SignInLanding} `SmartAppRoot` provides; throws outside it. */
const useSignInLanding = (): SignInLanding => useContextOrThrow(SignInLandingContext)

export { SignInLandingContext, useSignInLanding }
