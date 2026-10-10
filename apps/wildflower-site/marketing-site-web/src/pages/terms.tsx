import type { JSX } from 'react'

import { PolicyPage, PolicySection } from '../components/policy-page.tsx'

const EMAIL = 'ruthmarks151@gmail.com'

/**
 * `/terms/` — the terms of use of the website, the web apps, Wildflower Host
 * and the relay. The telemetry consent dialog's Continue button is the
 * acceptance of these terms, so its copy in `branding-core` links here. The
 * warranty and liability sections are the ones the dialog's as-is sentence
 * summarises, so they are plain prose at body size, never small print.
 */
function Terms(): JSX.Element {
  return (
    <PolicyPage title="Terms of use" updated="2026-10-10">
      <PolicySection title="Who this covers">
        <p>
          These terms are between you and me, Ruth Marks, who runs the Wildflower Health Project as
          an individual. They cover the website at wildflowerhealth.io, the web apps published
          there, the Wildflower Host app for desktop, iOS and Android, the Pebble watchapps, and the
          Wildflower relay. How your data is handled is in the{' '}
          <a href="../privacy-policy/">privacy policy</a>.
        </p>
      </PolicySection>

      <PolicySection title="Accepting these terms">
        <p>
          You accept these terms when you press Continue on the dialog each app shows before it
          starts, and each time you use the website, the apps or the relay. If you don&rsquo;t agree
          with them, don&rsquo;t use them.
        </p>
        <p>You must be at least 13 years old to use the apps.</p>
      </PolicySection>

      <PolicySection title="What Wildflower is">
        <p>
          Wildflower is an early-stage open source experiment in what a personal health record could
          look like. The apps show, store and move health records between you and the FHIR servers
          you choose. Its code has not been independently audited, and it changes often.
        </p>
      </PolicySection>

      <PolicySection title="Not medical advice">
        <p>
          Nothing in Wildflower is medical advice, diagnosis or treatment, and the apps are not a
          medical device. They may show records late, incompletely or wrongly, and they may be
          unavailable. Don&rsquo;t make decisions about your health on what they show without
          checking with a clinician, and never rely on them in an emergency. In an emergency, call
          your local emergency number.
        </p>
      </PolicySection>

      <PolicySection title="Your records, your server, your device">
        <ul>
          <li>
            You choose which FHIR servers you connect the apps to and which records you load into
            Wildflower Host. Use your own judgement about which to trust the apps with.
          </li>
          <li>
            You may only connect the apps to records you are allowed to access, and you are
            responsible for how you use them.
          </li>
          <li>
            If you run a server, in Wildflower Host or elsewhere, you are responsible for it: for
            keeping your device, its passcode and your tunnel token safe, for who you give access
            to, and for what the server stores.
          </li>
          <li>
            Whoever runs the FHIR server you connect to, not me, is responsible for the records on
            it.
          </li>
        </ul>
      </PolicySection>

      <PolicySection title="The relay">
        <p>
          The relay is offered free, as is, to reach a Wildflower server on your own device from the
          web. Using it, you agree:
        </p>
        <ul>
          <li>to use your tunnel only for your own Wildflower server, and not to resell it;</li>
          <li>
            not to send unlawful content through it, or use it to attack or overload anything;
          </li>
          <li>
            that I may suspend or delete a tunnel that breaks these terms or threatens the relay,
            and may change or stop the relay at any time, with notice on this site where I can;
          </li>
          <li>
            that your tunnel&rsquo;s address becomes public in the Certificate Transparency logs
            when its certificate is issued, and can&rsquo;t be removed from them.
          </li>
        </ul>
      </PolicySection>

      <PolicySection title="The code">
        <p>
          The code is published in the{' '}
          <a href="https://github.com/wildflowerhealthio/Wildflower">project&rsquo;s repository</a>.
          Any licence the repository carries governs the code itself. These terms govern the
          website, the published apps and the relay.
        </p>
      </PolicySection>

      <PolicySection title="No warranty">
        <p>
          The website, apps and relay are provided &ldquo;as is&rdquo; and &ldquo;as
          available&rdquo;, without warranty of any kind, express or implied, including any warranty
          of merchantability, fitness for a particular purpose, accuracy, availability or
          non-infringement. I don&rsquo;t promise that they will work without error or interruption,
          that defects will be fixed, or that any record they show is complete or correct.
        </p>
      </PolicySection>

      <PolicySection title="Limitation of liability">
        <p>
          To the fullest extent the law allows, neither I nor anyone who contributes to the project
          is liable to you for any claim, damages or other liability arising from the website, the
          apps or the relay, or from your use of or inability to use them. That includes loss of
          data, loss of records, missed or wrong health information, and any indirect, consequential
          or special loss, however caused and whether or not it was foreseeable. Where the law
          doesn&rsquo;t allow liability to be excluded, it is limited to the amount you paid to use
          Wildflower, which is nothing.
        </p>
        <p>
          Some places don&rsquo;t allow some of these exclusions or limitations, so they may not all
          apply to you. Nothing here limits rights the law gives you that can&rsquo;t be limited by
          agreement.
        </p>
      </PolicySection>

      <PolicySection title="Ending use">
        <p>
          You can stop using Wildflower at any time: uninstall the apps, clear your browser&rsquo;s
          data for the site, and ask me to delete your tunnel. The{' '}
          <a href="../deletion/">deletion page</a> says how. I may stop providing the website, the
          apps or the relay at any time.
        </p>
      </PolicySection>

      <PolicySection title="Changes">
        <p>
          When these terms change, the date at the top changes with it, and the apps ask you to
          accept them again. The page&rsquo;s full history is public in the repository.
        </p>
      </PolicySection>

      <PolicySection title="Contact">
        <p>
          Questions about these terms go to <a href={`mailto:${EMAIL}`}>{EMAIL}</a>.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}

export { Terms }
