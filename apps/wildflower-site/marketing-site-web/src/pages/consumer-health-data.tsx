import { POLICY_LABELS } from '@wildflowerhealthio/branding-core'
import type { JSX } from 'react'

import { PolicyPage, PolicySection } from '../components/policy-page.tsx'

const EMAIL = 'ruthmarks151@gmail.com'

/**
 * `/consumer-health-data/` — the consumer health data privacy policy some US
 * state laws ask for as a policy of its own, linked from the homepage:
 * Washington's My Health My Data Act (RCW 19.373.020) and Nevada's consumer
 * health data law (NRS 603A.400 to 603A.550). Its sections follow what those
 * laws ask a policy to say: what is collected and why, where it comes from,
 * who it is shared with, the rights and how to use them, cross-site tracking,
 * and how changes are announced. The rights are offered to everyone, wherever
 * they live, so the page names the laws only to say why it exists. It has to
 * agree with the privacy policy's crash report and email cards.
 */
function ConsumerHealthData(): JSX.Element {
  return (
    <PolicyPage title="Consumer health data privacy policy" updated="2026-10-11">
      <PolicySection title="Why this page exists">
        <p>
          Some US state laws, including Washington&rsquo;s My Health My Data Act and Nevada&rsquo;s
          consumer health data law, ask anyone who collects health data to publish a separate policy
          about it. This is that policy for the Wildflower Health Project, which I, Ruth Marks, run
          as an individual. The rights it describes apply to everyone, wherever you live.
        </p>
        <p>
          It covers only health data. Everything else is in the{' '}
          <a href="../privacy-policy/">{POLICY_LABELS.privacyPolicy}</a>.
        </p>
      </PolicySection>

      <PolicySection title="What I don't collect">
        <p>
          The apps read and write health records on the FHIR server you connect them to, or keep
          them on your own device in Wildflower Host. Those records don&rsquo;t reach me. I
          don&rsquo;t run a FHIR server, and I can&rsquo;t see what is on yours.
        </p>
      </PolicySection>

      <PolicySection title="What I may collect, and why">
        <ul>
          <li>
            <strong>Crash reports.</strong> When an app runs into an error, its report can include
            anything the app had loaded at the time, including names, medications, results and other
            health records. I collect them only if you turn Crash reports on, which is your consent,
            and use them only to find and fix the error. Both switches start off, and you can turn
            them off at any time.
          </li>
          <li>
            <strong>Emails you send me.</strong> Please don&rsquo;t put health information in them.
            If you do, I use it only to answer you.
          </li>
        </ul>
        <p>
          Performance data and session counts, the other things the apps can send, carry no record
          contents.
        </p>
      </PolicySection>

      <PolicySection title="Where it comes from">
        <p>
          Crash reports come from the app on your own device, at the moment of an error. Emails come
          from you.
        </p>
      </PolicySection>

      <PolicySection title="Who it is shared with">
        <ul>
          <li>
            <strong>Sentry</strong>, a third-party error-reporting service in the United States,
            stores crash reports for me under its data processing agreement, for no purpose of its
            own, and deletes each one 30 days after it arrives.
          </li>
          <li>
            <strong>Google</strong> hosts the email account you reach me at.
          </li>
        </ul>
        <p>
          I have no affiliates. I don&rsquo;t sell health data, and I don&rsquo;t share it with
          anyone else unless the law requires me to.
        </p>
      </PolicySection>

      <PolicySection title="Tracking across other sites">
        <p>
          Neither the website nor the apps let anyone collect information about what you do over
          time or across other websites and apps. There are no ads and no analytics on the website.
        </p>
      </PolicySection>

      <PolicySection title="Your rights">
        <p>You can ask me, free of charge:</p>
        <ul>
          <li>whether I hold health data about you, and to see it;</li>
          <li>who I have shared it with, and how to contact them;</li>
          <li>to correct it;</li>
          <li>to delete it;</li>
          <li>
            to withdraw your consent, which you can also do yourself by turning Crash reports off.
          </li>
        </ul>
        <p>
          Email <a href={`mailto:${EMAIL}`}>{EMAIL}</a>. Crash reports carry no user id, so name the
          app and roughly when you used it. I answer within 45 days, or tell you within those 45
          days if I need another 45. The <a href="../deletion/">{POLICY_LABELS.deletion}</a> page
          says what a deletion covers.
        </p>
        <p>
          If I refuse a request, you can appeal by replying to my answer, and I answer the appeal
          within 45 days, with my reasons. If that doesn&rsquo;t settle it, you can complain to your
          state&rsquo;s attorney general: in Washington, through the{' '}
          <a href="https://www.atg.wa.gov/file-complaint">
            Attorney General&rsquo;s complaint form
          </a>
          ; in Nevada, through the{' '}
          <a href="https://ag.nv.gov/Complaints/File_Complaint/">
            Attorney General&rsquo;s complaint form
          </a>
          .
        </p>
      </PolicySection>

      <PolicySection title="Changes">
        <p>
          This policy takes effect on the date at the top. When it changes, that date changes with
          it, and if the change is material the apps ask for your consent again before sending any
          more crash reports. The page&rsquo;s full history is public in the repository.
        </p>
      </PolicySection>
    </PolicyPage>
  )
}

export { ConsumerHealthData }
