import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import type { JSX } from 'react'

import { IssuedCodePanel } from './issued-code-panel.tsx'
import { useIssueOpenClaimCodeMutation } from './queries/index.ts'
import styles from './open-claim-codes.module.css'

/**
 * Issue a claim code that names no tunnel: a code for someone without a
 * tunnel yet, which their device redeems once for a new tunnel under the
 * email and subdomain they choose. The code replaces the button until the
 * operator is done with it.
 */
const OpenClaimCodes = (): JSX.Element => {
  const issue = useIssueOpenClaimCodeMutation()
  return Option.match(Option.fromNullable(issue.data), {
    onSome: (issued) => (
      <IssuedCodePanel
        key="issued-open-claim-code"
        title="New claim code"
        issued={issued}
        recipient="the person adding a server"
        onDone={() => {
          issue.reset()
        }}
      >
        Their device redeems it once for a new tunnel, under the email and subdomain they choose.
      </IssuedCodePanel>
    ),
    onNone: () => (
      <section className={styles['open-claim-codes']}>
        <h2 className="text-heading-4">Claim codes for new servers</h2>
        <p className="text-body-2">
          A claim code lets someone add a server without a tunnel made for them: they choose its
          email and subdomain when they enter the code.
        </p>
        <ErrorBanner error={issue.error} />
        <div className={styles['open-claim-codes__actions']}>
          <button
            type="button"
            className="button-2 filled"
            disabled={issue.isPending}
            onClick={() => {
              issue.mutate()
            }}
          >
            Issue claim code
          </button>
        </div>
      </section>
    ),
  })
}

export { OpenClaimCodes }
