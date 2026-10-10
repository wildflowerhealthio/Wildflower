import { POLICY_LABELS, policyUrl } from '@wildflowerhealthio/branding-core'
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
 * to, then the services involved, then the sections particular laws ask for
 * (Washington's consumer health data law, the GDPR). Every claim here has to
 * stay true of the code (the telemetry consent copy in `branding-core`, the
 * relay's `tunnels` table) and of the Sentry organisation's settings, so change
 * this page with them.
 */
function PrivacyPolicy(): JSX.Element {
  return (
    <PolicyPage title="Privacy policy" updated="2026-10-10">
      <PolicySection title="In short">
        <ul>
          <li>
            Your health records stay between you and the FHIR server you choose. I don&rsquo;t run a
            FHIR server, and I can&rsquo;t see what is on yours.
          </li>
          <li>Nothing is reported unless you turn crash reports or performance data on.</li>
          <li>There are no accounts, no ads, no analytics on the website, and nothing is sold.</li>
          <li>The relay stores an email address only for tunnels registered with it.</li>
          <li>
            This is early-stage software, unaudited and provided as is. It is not medical advice.
            Use your own judgement about which records you connect.
          </li>
        </ul>
      </PolicySection>

      <PolicySection title="Who this covers">
        <p>
          The Wildflower Health Project is an open source project run by me, Ruth Marks, as an
          individual. It is not a company. This policy covers:
        </p>
        <ul>
          <li>the website at wildflowerhealth.io and the web apps published there</li>
          <li>the Wildflower Host app for desktop, iOS and Android</li>
          <li>the Pebble watchapps</li>
          <li>the Wildflower relay</li>
        </ul>
        <p>
          Using them is also subject to the <a href="../terms/">{POLICY_LABELS.terms}</a>. Questions
          go to <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
        </p>
      </PolicySection>

      <PolicySection title="Where your records live">
        <p>
          I don&rsquo;t run a FHIR server. The web apps read and write records on the FHIR server
          you connect them to: your health system&rsquo;s, a test server, or a server you run
          yourself, including one running in Wildflower Host on your own device. Wildflower Host
          keeps the records you load into it on that device.
        </p>
        <p>
          When a web app reaches a server running on your device, the connection goes through the
          relay. The relay forwards it encrypted, and the only key that can decrypt it is on your
          device, so the relay can&rsquo;t read your records.
        </p>
        <p>
          Whoever runs your FHIR server is responsible for it, including when that is you. I
          can&rsquo;t see what is on it, so I can&rsquo;t detect a breach of it or tell you about
          one.
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
            title="Your telemetry preferences and sign-in state"
            where="Your browser's storage for wildflowerhealth.io."
            when="When you set your telemetry preferences and sign in to a FHIR server."
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
                <a href="../deletion/">{POLICY_LABELS.deletion}</a>.
              </>
            }
          />
          <PolicyDataCard
            title="Your telemetry preferences"
            where="In the app's storage on your device."
            when="When you set your telemetry preferences."
            keptFor="Until you clear it."
            delete="Clear the app's storage or uninstall it."
          />
        </PolicyDataGroup>

        <PolicyDataGroup title="Web apps and Wildflower Host, if you opt in">
          <PolicyDataCard
            title="Crash reports"
            where="Sentry, a third-party error-reporting service in the United States."
            when="Only if you turn Crash reports on."
            keptFor="90 days. Sentry deletes each report 90 days after it arrives."
            delete="Email me with the app and roughly when you used it."
          />
          <PolicyDataCard
            title="Performance data and session counts"
            where="Sentry, in the United States."
            when="Only if you turn Performance data on. Session counts are sent while either switch is on."
            keptFor="90 days, the same as crash reports."
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
            when="Only when a tunnel is registered with the relay."
            keptFor="Until the tunnel is deleted."
            delete="Email me from the address the tunnel is registered to."
          />
          <PolicyDataCard
            title="Your tunnel's address"
            where="In the public Certificate Transparency logs, which every certificate authority writes to."
            when="When a certificate is issued for your tunnel's address, by Let's Encrypt, from your device."
            keptFor="Permanently. Nobody can remove an entry from those logs."
            delete="It can't be. Choose a tunnel name you are happy to have public."
          />
        </PolicyDataGroup>

        <PolicyDataGroup title="Emailing me">
          <PolicyDataCard
            title="Your emails"
            where="My email account, which Google hosts."
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
          <li>
            The apps don&rsquo;t attach user details, cookies or request headers, and Sentry is set
            not to store the network address a report arrives from. So a report is tied to you only
            by whatever record contents it happens to carry.
          </li>
        </ul>
        <p>
          Change your answer at any time with the Telemetry button in the web apps, or the Telemetry
          row in Wildflower Host&rsquo;s Settings.
        </p>
      </PolicySection>

      <PolicySection title="What the relay sees">
        <ul>
          <li>
            For each registered tunnel, the relay stores its name, the email address it is
            registered to, its access token and when it was registered. The email address is used
            only for contact about that tunnel.
          </li>
          <li>
            It forwards each connection to your device by the address it asks for, without
            decrypting it. The certificate for that address is issued to, and stays on, your device.
          </li>
          <li>
            It passes the caller&rsquo;s network address on to your device, for your own logs.
          </li>
          <li>Its own logs record tunnel names for refused connections, not requests.</li>
        </ul>
      </PolicySection>

      <PolicySection title="If something goes wrong">
        <p>
          The only data about you that I might hold is in crash reports you chose to send, in a
          relay tunnel&rsquo;s registration, and in emails you send me. If I learn that any of it
          was lost, or disclosed to someone it shouldn&rsquo;t have been, I will say so on this site
          and in the apps within 60 days, with what happened and what you can do, email anyone whose
          address I hold, and notify the authorities where the law requires.
        </p>
        <p>
          I can&rsquo;t see the FHIR servers you connect to, so I can&rsquo;t detect a breach of
          one. If you suspect one, tell whoever runs that server.
        </p>
      </PolicySection>

      <PolicySection title="Other services involved">
        <ul>
          <li>
            <strong>Sentry</strong> receives the reports you opt in to, under its data processing
            agreement, and keeps them for 90 days. See{' '}
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
            <strong>Let&rsquo;s Encrypt</strong> issues the certificate for your tunnel&rsquo;s
            address, from your device, and records that address in the public Certificate
            Transparency logs.
          </li>
          <li>
            <strong>Google</strong> hosts the email account you reach me at.
          </li>
          <li>
            <strong>The Apple App Store, Google Play and the Pebble app store</strong> distribute
            the apps, each under its own privacy policy.
          </li>
        </ul>
        <p>
          No data is shared with anyone else, and none is sold, unless the law requires me to
          disclose it.
        </p>
      </PolicySection>

      <PolicySection title="Washington residents: consumer health data">
        <p>
          This section is the consumer health data privacy policy Washington&rsquo;s My Health My
          Data Act asks for. It also serves residents of Nevada and Connecticut, whose health data
          laws give similar rights, by the same process.
        </p>
        <ul>
          <li>
            <strong>What I collect, and why.</strong> The only consumer health data I may collect is
            the contents of crash reports, which can include health records the app had loaded, used
            only to find and fix the error. I collect it only if you turn Crash reports on, which is
            your consent, and you can turn it off at any time.
          </li>
          <li>
            <strong>Where it comes from.</strong> The app on your own device, at the moment of an
            error.
          </li>
          <li>
            <strong>Who it is shared with.</strong> Sentry, which stores the reports for me under
            its data processing agreement and for no purpose of its own. I have no affiliates, and I
            don&rsquo;t sell consumer health data.
          </li>
          <li>
            <strong>Your rights.</strong> To know whether I hold consumer health data about you and
            to see it, to know who I have shared it with, to withdraw your consent, and to have it
            deleted. Email me. I answer within 45 days, or tell you within those 45 days if I need
            another 45. If I refuse, you can appeal by replying, and I answer the appeal within 45
            days. If that doesn&rsquo;t settle it, you can complain to the Washington Attorney
            General.
          </li>
        </ul>
      </PolicySection>

      <PolicySection title="If you are in the EU, the UK or Switzerland">
        <ul>
          <li>
            <strong>Controller.</strong> Ruth Marks, reachable at{' '}
            <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
          </li>
          <li>
            <strong>Legal bases.</strong> Crash reports, performance data and session counts are
            sent only with your consent, which you give with the switches and can withdraw at any
            time with the same switches. The relay stores a tunnel&rsquo;s details because they are
            needed to provide the tunnel. I keep emails on the basis of my legitimate interest in
            answering them.
          </li>
          <li>
            <strong>Transfers.</strong> Sentry and the relay server are in the United States. Sentry
            is certified under the EU-US Data Privacy Framework, with its UK extension and the
            Swiss-US framework.
          </li>
          <li>
            <strong>Retention.</strong> As the cards above say: 90 days for anything sent to Sentry,
            until deleted for tunnel details, and until you ask for emails.
          </li>
          <li>
            <strong>Your rights.</strong> To access the data I hold about you, to have it corrected
            or deleted, to restrict or object to its processing, to receive a copy of it, and to
            withdraw consent. Email me, and I answer within one month. You can also complain to your
            data protection authority.
          </li>
          <li>
            <strong>No profiling.</strong> I make no automated decisions about you.
          </li>
        </ul>
      </PolicySection>

      <PolicySection title="Not medical advice">
        <p>
          The apps show, store and move health records. They don&rsquo;t diagnose, treat or
          recommend, and nothing in them is medical advice. Talk to a clinician about your health,
          and in an emergency call your local emergency number. Don&rsquo;t rely on these apps to be
          available or correct.
        </p>
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
          for any claim, damages or other liability arising from their use. The{' '}
          <a href={policyUrl('terms')}>{POLICY_LABELS.terms}</a> say this in full.
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
