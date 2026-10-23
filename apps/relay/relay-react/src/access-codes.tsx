import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import type { JSX } from 'react'

import { IssuedCodePanel } from './issued-code-panel.tsx'
import { useIssueAccessCodeMutation } from './queries/index.ts'
import styles from './access-codes.module.css'

/**
 * Issue an access code: a code for someone without a tunnel yet, which their
 * device redeems once for a new tunnel under the email and subdomain they
 * choose. The code replaces the button until the operator is done with it.
 */
const AccessCodes = (): JSX.Element => {
  const issue = useIssueAccessCodeMutation()
  return Option.fromNullable(issue.data).pipe(
    Option.map((issued) => (
      <IssuedCodePanel
        key="issued-access-code"
        title="New access code"
        codeLabel="Access code"
        issued={issued}
        recipient="the person adding a server"
        onDone={() => {
          issue.reset()
        }}
      >
        Their device redeems it once for a new tunnel, under the email and subdomain they choose.
      </IssuedCodePanel>
    )),
    Option.getOrElse(() => (
      <section className={styles['access-codes']}>
        <h2 className="text-heading-4">Access codes</h2>
        <p className="text-body-2">
          An access code lets someone add a server without a tunnel made for them: they choose its
          email and subdomain when they enter the code.
        </p>
        <ErrorBanner error={issue.error} />
        <div className={styles['access-codes__actions']}>
          <button
            type="button"
            className="button-2 filled"
            disabled={issue.isPending}
            onClick={() => {
              issue.mutate()
            }}
          >
            Issue access code
          </button>
        </div>
      </section>
    ))
  )
}

export { AccessCodes }
