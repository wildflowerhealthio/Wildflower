import { Cause, Effect, Exit, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import * as CertificateAuthority from './certificate-authority.ts'
import { HostCommandFailed, TauriInvoke } from './host-commands.ts'
import * as LaunchError from './launch-error.ts'
import { launchServer, openServerAuthorizationApp } from './server-commands.ts'
import * as ServerStatus from './server-status.ts'

const decodeStatus = Schema.decodeUnknownSync(ServerStatus.Schema)

/** `golden.serverStatuses.runningAndReachable` with its certificate's status set to `status`. */
const runningAndReachableWithCertificate = (status: string): ServerStatus.Type =>
  decodeStatus({
    ...golden.serverStatuses.runningAndReachable,
    certificate: { ...golden.serverStatuses.runningAndReachable.certificate, status },
  })

describe('LaunchError.statusRefusalOf', () => {
  const refusals = new Map(Object.entries(golden.launchRefusals))

  it.each(Object.entries(golden.serverStatuses))(
    "should refuse %s as the host's server_launch does",
    (name, status) => {
      // Act
      const refused = LaunchError.statusRefusalOf(decodeStatus(status))

      // Assert
      expect(refusals.has(name)).toBe(true)
      expect(refused).toEqual(Option.fromNullable(refusals.get(name)))
    }
  )

  it.each(Object.entries(golden.launchRefusalsByCertificateStatus))(
    "should refuse a running, reachable server whose certificate is %s as the host's server_launch does",
    (certificateStatus, refusal) => {
      // Act
      const refused = LaunchError.statusRefusalOf(
        runningAndReachableWithCertificate(certificateStatus)
      )

      // Assert
      expect(refused).toEqual(Option.fromNullable(refusal))
    }
  )
  it.each(['tokenRejected', 'tunnelUnknown'] as const)(
    'should refuse a running server whose relay refused its tunnel as %s before its health is reported',
    (kind) => {
      // Act
      const refused = LaunchError.statusRefusalOf(
        decodeStatus({ ...golden.serverStatuses.runningRenewalFailed, tunnel: { kind } })
      )

      // Assert
      expect(refused).toEqual(Option.some(kind))
    }
  )
})

describe('CertificateAuthority.isBrowserTrusted', () => {
  it.each(Object.entries(golden.browserTrustedCertificateAuthorities))(
    'should say whether browsers trust %s as the host does',
    (authority, trusted) => {
      // Act
      const said = CertificateAuthority.isBrowserTrusted(
        Schema.decodeUnknownSync(CertificateAuthority.Schema)(authority)
      )

      // Assert
      expect(said).toBe(trusted)
    }
  )
})

describe.each([
  { name: 'launchServer', open: launchServer, command: 'server_launch' },
  {
    name: 'openServerAuthorizationApp',
    open: openServerAuthorizationApp,
    command: 'server_open_authorization_app',
  },
])('$name', ({ open, command }) => {
  it(`should send ${command} the domain, and answer with nothing`, async () => {
    // Arrange
    const seen: unknown[] = []

    // Act
    const exit = await Effect.runPromiseExit(
      Effect.provideService(
        open({ domain: 'ruth.relay.example.com' }),
        TauriInvoke,
        (name, args) => {
          seen.push({ command: name, args })
          return Promise.resolve(null)
        }
      )
    )

    // Assert
    expect(seen).toEqual([{ command, args: { domain: 'ruth.relay.example.com' } }])
    expect(exit).toEqual(Exit.succeed(null))
  })

  it.each(golden.launchErrors)("should fail with the host's $kind refusal", async (error) => {
    // Act
    const exit = await Effect.runPromiseExit(
      Effect.provideService(open({ domain: 'ruth.relay.example.com' }), TauriInvoke, () =>
        Promise.reject(error)
      )
    )

    // Assert
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : Option.none()
    const refusal = failure.pipe(
      Option.flatMap((cause) =>
        cause instanceof HostCommandFailed ? cause.refusal : Option.none()
      )
    )
    expect(refusal).toEqual(Option.some(error))
  })
})
