import { createFileRoute } from '@tanstack/react-router'
import { AnonymizerScreen } from '@wildflowerhealthio/anonymizer-react'
import type { JSX } from 'react'

import { ServerSource } from './-server-source.tsx'

/**
 * The Anonymize tab: `anonymizer-react`'s server-blind screen, with this
 * app's uploaded source files offered as its server source.
 */
function AnonymizeTab(): JSX.Element {
  return <AnonymizerScreen serverSource={ServerSource} />
}

/** `/anonymize`, the Anonymize tab. */
const Route = createFileRoute('/anonymize')({
  staticData: {
    subtitle: 'Replace every value in a capture with a pseudonym so its shape can be shared.',
  },
  component: AnonymizeTab,
})

export { Route }
