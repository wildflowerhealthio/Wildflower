import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { ClaimCodeTarget, invitationMailtoOf } from './index.ts'

/** 2023-11-14T22:28:20Z: the 14th in Toronto, already the 15th in Auckland. */
const EXPIRES_AT = DateTime.unsafeMake(1_700_000_900_000)
const TORONTO = DateTime.zoneUnsafeMakeNamed('America/Toronto')
const AUCKLAND = DateTime.zoneUnsafeMakeNamed('Pacific/Auckland')

/** The subject, body and recipient a mail client reads from `mailto`. */
const emailOf = (
  mailto: string
): {
  readonly recipient: string
  readonly subject: string | null
  readonly body: string | null
} => {
  const url = new URL(mailto)
  return {
    recipient: url.pathname,
    subject: url.searchParams.get('subject'),
    body: url.searchParams.get('body'),
  }
}

/** The body's lines, as written; a mail client gets them joined by CRLF. */
const bodyWith = (redeemSteps: ReadonlyArray<string>, expiresOn: string): string =>
  [
    'Hi,',
    '',
    'I’d like to invite you to try Wildflower. It’s an app that keeps your health records on your own device and lets you reach them from anywhere, without handing them to a cloud service.',
    '',
    'Here’s how to get set up:',
    '',
    '1. Install Wildflower from whichever of these suits your devices:',
    '   - Android: https://play.google.com/apps/internaltest/4701685308511982765',
    '   - iOS / macOS (TestFlight): https://testflight.apple.com/join/cmZEzxdS',
    '   - Windows / Linux / other downloads (GitHub Releases): https://github.com/wildflowerhealthio/Wildflower/releases',
    '   - Pebble watch apps: https://apps.repebble.com/apps/dev/wildflowerhealth-io_5869ca164bb23a2487974552',
    '2. Open the app and choose Add new server. Pick “Wildflower official relay”.',
    ...redeemSteps,
    '',
    `The code works once and expires on ${expiresOn}. If it runs out before you get to it, just reply and I’ll send a new one.`,
    '',
    'You can learn more at https://WildflowerHealth.io.',
    '',
    'Welcome aboard!',
    '',
    'Ruth Marks',
  ].join('\r\n')

describe('invitationMailtoOf', () => {
  it('invites a new server to choose its email and subdomain, with a random one by default', () => {
    // Act
    const mailto = invitationMailtoOf(
      { code: 'JKMN-PQRS', expires_at: EXPIRES_AT },
      ClaimCodeTarget.Open(),
      TORONTO
    )

    // Assert
    expect(emailOf(mailto)).toEqual({
      recipient: '',
      subject: 'Your invitation to Wildflower',
      body: bodyWith(
        [
          '3. Enter your claim code: JKMN-PQRS',
          '4. Choose your email and a subdomain. The subdomain is optional and becomes part of your server’s web address. If you leave it blank, you’ll get a random one made of two words.',
        ],
        'November 14, 2023'
      ),
    })
  })

  it('invites a tunnel’s owner to connect to it, dating the expiry in the sender’s zone', () => {
    // Act
    const mailto = invitationMailtoOf(
      { code: 'ABCD-EFGH', expires_at: EXPIRES_AT },
      ClaimCodeTarget.Preset({ tunnelName: 'bob' }),
      AUCKLAND
    )

    // Assert
    expect(emailOf(mailto)).toEqual({
      recipient: '',
      subject: 'Your invitation to Wildflower',
      body: bodyWith(
        [
          '3. Enter your claim code: ABCD-EFGH. It connects your device to the tunnel I’ve set up for you, bob.',
        ],
        'November 15, 2023'
      ),
    })
  })

  it('carries any code and tunnel name through the link intact, to no recipient', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (code, tunnelName) => {
        // Act
        const email = emailOf(
          invitationMailtoOf(
            { code, expires_at: EXPIRES_AT },
            ClaimCodeTarget.Preset({ tunnelName }),
            TORONTO
          )
        )

        // Assert
        expect(email.recipient).toBe('')
        expect(email.body?.split('\r\n')).toContain(
          `3. Enter your claim code: ${code}. It connects your device to the tunnel I’ve set up for you, ${tunnelName}.`
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
