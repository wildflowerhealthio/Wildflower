import type { JSX } from 'react'

import {
  PolicyDataCard,
  PolicyDataGroup,
  PolicyPage,
  PolicySection,
} from '../components/policy-page.tsx'

const EMAIL = 'ruthmarks151@gmail.com'

/**
 * `/privacy-policy/` — what the website, the apps, and the relay collect, where
 * it goes, and who else sees it. Structured to be scanned: a summary, then one
 * card per kind of data with the same four facts, grouped by the app it belongs
 * to, then the services involved. Every
 * claim here has to stay true of the code (the telemetry consent copy in
 * `branding-core`, the relay's `tunnels` table), so change this page with them.
 */
function PrivacyPolicy(): JSX.Element {
  return (
    <PolicyPage title="Privacy policy" updated="2026-10-10">
      <PolicySection title="In short">
        <ul>
          <li>Your health records go between you and the FHIR server you choose, not to me.</li>
          <li>Nothing is reported unless you turn crash reports or performance data on.</li>
          <li>There are no accounts, no ads, no analytics on the website, and nothing is sold.</li>
          <li>The relay stores your email address only if I set up a tunnel for you.</li>
          <li>
            This is early-stage software, unaudited and provided as is. Use your own judgement about
            which records you connect.
          </li>
        </ul>
      </PolicySection>

      <PolicySection title="Who this covers">
        <p>
          The Wildflower Health Project is an open source project run by me, Ruth Marks. It is not a
          company. This policy covers:
        </p>
        <ul>
          <li>the website at wildflowerhealth.io and the web apps published there</li>
          <li>the Wildflower Host app for desktop, iOS and Android</li>
          <li>the Pebble watchapps</li>
          <li>the Wildflower relay</li>
        </ul>
        <p>
          Questions go to <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
        </p>
      </PolicySection>

      <PolicySection title="What is kept, and where">
        <p>
          Grouped by the app you use. Each card says where the data is kept, when, for how long, and
          how to delete it.
        </p>

        <PolicyDataGroup title="Web apps on wildflowerhealth.io">
          <PolicyDataCard
            title="Health records you connect to"
            where="On the FHIR server you connect the app to. Your browser holds them only while the app is open."
            when="Whenever you use an app. Records an app writes, such as Lifting's workouts, are saved to that server."
            keptFor="Whatever that server's own policies say."
            delete="On that server, or by asking whoever runs it."
          />
          <PolicyDataCard
            title="Your telemetry answer and sign-in state"
            where="Your browser's storage for wildflowerhealth.io."
            when="When you answer the telemetry question and sign in to a FHIR server."
            keptFor="Until you clear it."
            delete="Clear the site data for wildflowerhealth.io in your browser."
          />
        </PolicyDataGroup>

        <PolicyDataGroup title="Wildflower Host (desktop, iOS and Android)">
          <PolicyDataCard
            title="Records you load into it"
            where="On your device only."
            when="When you load records into the app."
            keptFor="Until you delete them or the app."
            delete={
              <>
                Clear the app&rsquo;s storage or uninstall it. See{' '}
                <a href="../deletion/">Deleting your data</a>.
              </>
            }
          />
          <PolicyDataCard
            title="Your telemetry answer"
            where="In the app's storage on your device."
            when="When you answer the telemetry question."
            keptFor="Until you clear it."
            delete="Clear the app's storage or uninstall it."
          />
        </PolicyDataGroup>

        <PolicyDataGroup title="Web apps and Wildflower Host, if you opt in">
          <PolicyDataCard
            title="Crash reports"
            where="Sentry, a third-party error-reporting service in the United States."
            when="Only if you turn Crash reports on."
            keptFor="Sentry's standard retention period."
            delete="Email me with the app and roughly when you used it."
          />
          <PolicyDataCard
            title="Performance data and session counts"
            where="Sentry, in the United States."
            when="Only if you turn Performance data on. Session counts are sent while either switch is on."
            keptFor="Sentry's standard retention period."
            delete="Email me, the same as for crash reports."
          />
        </PolicyDataGroup>

        <PolicyDataGroup title="Pebble watchapps">
          <PolicyDataCard
            title="Settings and synced data"
            where="In the Pebble phone app and on your watch."
            when="When you set up a watchapp and it syncs."
            keptFor="Until you remove the watchapp."
            delete="Remove the watchapp from the Pebble phone app."
          />
        </PolicyDataGroup>

        <PolicyDataGroup title="The relay">
          <PolicyDataCard
            title="Tunnel details"
            where="On the relay server, hosted by DigitalOcean."
            when="Only if I set up a relay tunnel for you."
            keptFor="Until the tunnel is deleted."
            delete="Email me from the address the tunnel was set up with."
          />
        </PolicyDataGroup>

        <PolicyDataGroup title="Emailing me">
          <PolicyDataCard
            title="Your emails"
            where="My email account."
            when="When you email me."
            keptFor="Until you ask me to delete them."
            delete="Email me and ask."
          />
        </PolicyDataGroup>
      </PolicySection>

      <PolicySection title="What a crash report can contain">
        <p>Every app asks before it reports anything. Both switches start off.</p>
        <ul>
          <li>
            <strong>Crash reports</strong> describe an error. A report can include anything the app
            had loaded at the time, including names, medications, results, record ids and server
            addresses.
          </li>
          <li>
            <strong>Performance data</strong> is anonymized timings: how long pages and requests
            take, and the names of the pages and resource types requested. Record ids and query
            strings are removed first, and no record contents are sent.
          </li>
          <li>
            <strong>Session counts</strong> record that the app was opened, whether it ran into an
            error, and the browser and operating system it ran on.
          </li>
          <li>The apps don&rsquo;t attach user details, cookies or request headers.</li>
        </ul>
        <p>
          Change your answer at any time with the Telemetry button in the web apps, or the Telemetry
          row in Wildflower Host&rsquo;s Settings.
        </p>
      </PolicySection>

      <PolicySection title="What the relay sees">
        <ul>
          <li>
            The relay stores a tunnel&rsquo;s name, your email address, its access token and when it
            was created. I use the email address only to contact you about the tunnel.
          </li>
          <li>
            It forwards each connection to your device by the address it asks for, without
            decrypting it.
          </li>
          <li>
            It passes the caller&rsquo;s network address on to your device, for your own logs.
          </li>
          <li>Its own logs record tunnel names for refused connections, not requests.</li>
        </ul>
      </PolicySection>

      <PolicySection title="Other services involved">
        <ul>
          <li>
            <strong>Sentry</strong> receives the reports you opt in to. See{' '}
            <a href="https://sentry.io/privacy/">Sentry&rsquo;s privacy policy</a>.
          </li>
          <li>
            <strong>GitHub Pages</strong> hosts the website and may log each visit&rsquo;s network
            address. See the{' '}
            <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
              GitHub privacy statement
            </a>
            .
          </li>
          <li>
            <strong>DigitalOcean</strong> hosts the relay server.
          </li>
          <li>
            <strong>The Apple App Store, Google Play and the Pebble app store</strong> distribute
            the apps, each under its own privacy policy.
          </li>
        </ul>
        <p>No data is shared with anyone else.</p>
      </PolicySection>

      <PolicySection title="Early-stage software">
        <p>
          This is an early-stage project, and its code has not been independently audited. Use your
          own judgement about which health records you connect the apps to or load into them. You
          can review the code yourself in the{' '}
          <a href="https://github.com/wildflowerhealthio/Wildflower">project&rsquo;s repository</a>.
        </p>
        <p>
          The website, apps and relay are provided &ldquo;as is&rdquo;, without warranty of any
          kind, express or implied. To the fullest extent the law allows, the authors are not liable
          for any claim, damages or other liability arising from their use.
        </p>
      </PolicySection>

      <PolicySection title="Children">
        <p>
          The apps are not meant for children under 13, and I don&rsquo;t knowingly collect data
          from them.
        </p>
      </PolicySection>

      <PolicySection title="Changes">
        <p>
          When this policy changes, the date at the top changes with it. The page&rsquo;s full
          history is public in the repository.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}

export { PrivacyPolicy }
