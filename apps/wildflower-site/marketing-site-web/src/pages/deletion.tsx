import type { JSX } from 'react'

import { PolicyPage, PolicySection } from '../components/policy-page.tsx'

/**
 * `/deletion/` — how to delete each kind of data the privacy policy describes:
 * what you can delete yourself, and what to email for. Google Play links here
 * as Wildflower Host's data-deletion page, so it names the app and the
 * developer and lists what is deleted and what is kept.
 */
function Deletion(): JSX.Element {
  return (
    <PolicyPage title="Deleting your data" updated="2026-10-10">
      <PolicySection title="Who this covers">
        <p>
          This page explains how to delete the data kept by Wildflower Host and the other apps of
          the Wildflower Health Project, developed by Ruth Marks. The{' '}
          <a href="../privacy-policy/">privacy policy</a> describes what that data is.
        </p>
      </PolicySection>

      <PolicySection title="Ask me to delete your data">
        <p>
          Email <a href="mailto:ruthmarks151@gmail.com">ruthmarks151@gmail.com</a> with the subject
          &ldquo;Delete my data&rdquo;. Say what you want deleted:
        </p>
        <ul>
          <li>
            <strong>Crash reports.</strong> Name the app and roughly when you used it. I delete the
            matching reports and session counts from Sentry.
          </li>
          <li>
            <strong>A relay tunnel.</strong> Send the email from the address the tunnel is
            registered to, and name the tunnel. I delete the tunnel and everything the relay stores
            about it: its name, the registered email address, its access token and its registration
            date.
          </li>
          <li>
            <strong>Our emails.</strong> I delete our conversation from my email account.
          </li>
        </ul>
        <p>
          I reply to confirm, and finish the deletion within 30 days. Nothing is kept afterwards,
          except that certificates already issued for a tunnel&rsquo;s address stay in the public
          Certificate Transparency logs, which nobody can remove them from.
        </p>
      </PolicySection>

      <PolicySection title="Data on your device">
        <p>Wildflower Host keeps the records you load into it on your device, and nowhere else.</p>
        <ul>
          <li>
            <strong>Android:</strong> open Settings, then Apps, then Wildflower Host, then Storage,
            and choose Clear storage. Uninstalling the app also deletes its data.
          </li>
          <li>
            <strong>iOS:</strong> delete the app from your Home Screen. Its data is deleted with it.
          </li>
          <li>
            <strong>Desktop:</strong> uninstall the app and delete its data folder, named{' '}
            <code>io.wildflowerhealth.hostapp</code>, in your system&rsquo;s app data location.
          </li>
        </ul>
        <p>
          The Pebble watchapps&rsquo; settings and synced data are deleted when you remove the
          watchapp from the Pebble phone app.
        </p>
      </PolicySection>

      <PolicySection title="Data in your browser">
        <p>
          The web apps keep only your telemetry preferences and your sign-in state in your browser.
          To delete them, clear the site data for wildflowerhealth.io in your browser&rsquo;s
          settings.
        </p>
      </PolicySection>

      <PolicySection title="Data on your FHIR server">
        <p>
          Records the apps read or write live on the FHIR server you connected them to, which I
          don&rsquo;t run. To delete them, ask whoever runs that server, or delete them from your
          own server if you run it yourself.
        </p>
      </PolicySection>

      <PolicySection title="Stop sending crash reports">
        <p>
          Turn both switches off with the Telemetry button in the web apps, or the Telemetry row in
          Wildflower Host&rsquo;s Settings. Nothing more is sent after that.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}

export { Deletion }
