import type { JSX } from 'react'

import { PolicyPage, PolicySection } from '../components/policy-page.tsx'

/**
 * `/privacy-policy/` — what the website, the apps, and the relay collect, where
 * it goes, and who else sees it. Plain first-person prose like the homepage;
 * every claim here has to stay true of the code (the telemetry consent copy in
 * `branding-core`, the relay's `tunnels` table), so change this page with them.
 */
function PrivacyPolicy(): JSX.Element {
  return (
    <PolicyPage title="Privacy policy" updated="2026-10-10">
      <PolicySection title="Who this covers">
        <p>
          The Wildflower Health Project is an open source project run by me, Ruth Marks. It is not a
          company. This policy covers the website at wildflowerhealth.io, the web apps published
          there, the Wildflower Host app for desktop, iOS and Android, the Pebble watchapps, and the
          Wildflower relay.
        </p>
        <p>
          Questions go to <a href="mailto:ruthmarks151@gmail.com">ruthmarks151@gmail.com</a>.
        </p>
      </PolicySection>

      <PolicySection title="Use synthetic data only">
        <p>
          These are demo apps. Use them only with synthetic or test data, and never connect them to
          a real person&rsquo;s health record. The apps say so before they start.
        </p>
      </PolicySection>

      <PolicySection title="Health records">
        <p>
          The web apps run in your browser and talk directly to the FHIR server you connect them to.
          The records they read or write go between your browser and that server. They are not sent
          to me. Records the apps write, such as Lifting&rsquo;s workouts, are stored on that
          server, under that server&rsquo;s own policies.
        </p>
        <p>
          Wildflower Host keeps the records you load into it on your device. The Pebble watchapps
          keep the server address and settings you give them in the Pebble phone app, and the data
          they sync on your watch.
        </p>
        <p>
          The only way record contents can leave your browser or device for somewhere other than
          your FHIR server is a crash report, and only if you turn crash reports on.
        </p>
      </PolicySection>

      <PolicySection title="Crash reports and performance data">
        <p>
          Every app asks before it reports anything. Two switches, both off at the start, choose
          what is sent to Sentry, a third-party error-reporting service in the United States. With
          both off, nothing is sent.
        </p>
        <ul>
          <li>
            <strong>Crash reports.</strong> When an app runs into an error, it sends a report of the
            error. A report can include anything the app had loaded at the time, including names,
            medications, results, record ids and server addresses.
          </li>
          <li>
            <strong>Performance data.</strong> Anonymized timings: how long pages and requests take,
            with the names of the pages and of the resource types requested. Record ids and query
            strings are removed first, and no record contents are sent.
          </li>
        </ul>
        <p>
          While either switch is on, Sentry also counts app sessions: that the app was opened,
          whether it ran into an error, and the browser and operating system it ran on. The apps do
          not attach user details, cookies or request headers to anything they send. You can change
          your answer at any time with the Telemetry button in the web apps or the Telemetry row in
          Wildflower Host&rsquo;s Settings.
        </p>
        <p>
          Sentry keeps reports for its standard retention period and then deletes them. See{' '}
          <a href="https://sentry.io/privacy/">Sentry&rsquo;s privacy policy</a>.
        </p>
      </PolicySection>

      <PolicySection title="The relay">
        <p>
          The relay lets a FHIR server running on your own device be reached from the internet. If I
          set up a relay tunnel for you, the relay stores the tunnel&rsquo;s name, your email
          address, the tunnel&rsquo;s access token, and when it was created. I use the email address
          only to contact you about your tunnel.
        </p>
        <p>
          The relay forwards each connection to your device by the address it asks for, without
          decrypting it. It passes the connecting address on to your device so your server can log
          who called it. The relay&rsquo;s own logs record the tunnel name for refused connections,
          not the requests themselves.
        </p>
      </PolicySection>

      <PolicySection title="What your browser and device store">
        <p>
          The web apps store your telemetry answer in your browser&rsquo;s local storage, and the
          sign-in state for the FHIR server you connected to in your browser&rsquo;s storage for
          that site. The website itself sets no cookies and runs no analytics or advertising.
        </p>
      </PolicySection>

      <PolicySection title="Hosting and app stores">
        <p>
          The website is hosted on GitHub Pages, and GitHub may log the network address of each
          visit under the{' '}
          <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
            GitHub privacy statement
          </a>
          . The relay runs on a DigitalOcean server. Wildflower Host and the watchapps are
          distributed through the Apple App Store, Google Play and the Pebble app store, each under
          its own privacy policy.
        </p>
      </PolicySection>

      <PolicySection title="Sharing">
        <p>
          I don&rsquo;t sell your data, show ads, or share data with anyone beyond the services
          named on this page. If you email me, I keep the conversation in my email account.
        </p>
      </PolicySection>

      <PolicySection title="Children">
        <p>
          The apps are not meant for children under 13, and I don&rsquo;t knowingly collect data
          from them.
        </p>
      </PolicySection>

      <PolicySection title="Deleting your data">
        <p>
          <a href="../deletion/">Deleting your data</a> explains how to delete what the apps keep on
          your device and how to ask me to delete crash reports or a relay tunnel.
        </p>
      </PolicySection>

      <PolicySection title="Changes">
        <p>
          When this policy changes, the date at the top of this page changes with it. The full
          history of this page is public in the{' '}
          <a href="https://github.com/wildflowerhealthio/Wildflower">project&rsquo;s repository</a>.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}

export { PrivacyPolicy }
