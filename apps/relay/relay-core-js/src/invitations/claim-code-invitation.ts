import { Data, DateTime, type Schema } from 'effect'

import type { Tunnels } from '../http-api-definition/index.ts'

/**
 * What a claim code redeems for, named for the relay's `ClaimCodeTarget`: an
 * existing tunnel's name and token, or a new tunnel under the email and
 * subdomain the redeemer chooses.
 */
type ClaimCodeTarget = Data.TaggedEnum<{
  readonly Preset: { readonly tunnelName: string }
  // oxlint-disable-next-line typescript/no-generated-empty-object-type -- an empty variant
  readonly Open: Record<never, never>
}>
const ClaimCodeTarget = Data.taggedEnum<ClaimCodeTarget>()

/** Where the recipient installs Wildflower, one line per store. */
const INSTALL_LINKS = [
  'Android: https://play.google.com/apps/internaltest/4701685308511982765',
  'iOS / macOS (TestFlight): https://testflight.apple.com/join/cmZEzxdS',
  'Windows / Linux / other downloads (GitHub Releases): https://github.com/wildflowerhealthio/Wildflower/releases',
  'Pebble watch apps: https://apps.repebble.com/apps/dev/wildflowerhealth-io_5869ca164bb23a2487974552',
]

/** The steps after installing that redeem `code` for `target`. */
const redeemStepsOf = (code: string, target: ClaimCodeTarget): ReadonlyArray<string> =>
  ClaimCodeTarget.$match(target, {
    Preset: ({ tunnelName }) => [
      `3. Enter your claim code: ${code}. It connects your device to the tunnel I’ve set up for you, ${tunnelName}.`,
    ],
    Open: () => [
      `3. Enter your claim code: ${code}`,
      '4. Choose your email and a subdomain. The subdomain is optional and becomes part of your server’s web address. If you leave it blank, you’ll get a random one made of two words.',
    ],
  })

/**
 * A `mailto:` link, with no recipient, whose subject and body invite someone
 * to install Wildflower and redeem `issued` for `target`. The expiry is
 * written as a date in `timeZone`, the sender's.
 */
const invitationMailtoOf = (
  issued: Schema.Schema.Type<typeof Tunnels.IssuedClaimCodeSchema>,
  target: ClaimCodeTarget,
  timeZone: DateTime.TimeZone
): string => {
  const expiresOn = DateTime.format(DateTime.setZone(issued.expires_at, timeZone), {
    locale: 'en-US',
    dateStyle: 'long',
  })
  const body = [
    'Hi,',
    '',
    'I’d like to invite you to try Wildflower. It’s an app that keeps your health records on your own device and lets you reach them from anywhere, without handing them to a cloud service.',
    '',
    'Here’s how to get set up:',
    '',
    '1. Install Wildflower from whichever of these suits your devices:',
    ...INSTALL_LINKS.map((link) => `   - ${link}`),
    '2. Open the app and choose Add new server. Pick “Wildflower official relay”.',
    ...redeemStepsOf(issued.code, target),
    '',
    `The code works once and expires on ${expiresOn}. If it runs out before you get to it, just reply and I’ll send a new one.`,
    '',
    'You can learn more at https://WildflowerHealth.io.',
    '',
    'Welcome aboard!',
    '',
    'Ruth Marks',
  ].join('\r\n')
  return `mailto:?subject=${encodeURIComponent('Your invitation to Wildflower')}&body=${encodeURIComponent(body)}`
}

export { ClaimCodeTarget, invitationMailtoOf }
