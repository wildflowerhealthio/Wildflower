import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView } from 'react-tundraish'

import { oauthConsentQueryOptions, useOAuthConsentQuery } from '../../../queries.ts'
import { ensureAuthedQuery } from '../../../router-loader.ts'
import { OAuthConsentForm } from '../../../screens/oauth-consent/oauth-consent-form.tsx'

const OAuthConsentScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: consent } = useOAuthConsentQuery(id)
  return (
    <OAuthConsentForm
      consent={consent}
      onDone={() => {
        void navigate({ to: '/settings/gatekeeper' })
      }}
    />
  )
}

/**
 * The `/gatekeeper/oauth-consent/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop. See {@link ensureAuthedQuery} for the loader's
 * token-ready guard and error-propagation contract.
 */
function OAuthConsentRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <OAuthConsentScreen id={id} />
}

export const Route = createFileRoute('/_auth/gatekeeper/oauth-consent/$id')({
  loader: ({ context, params }) =>
    ensureAuthedQuery(context, oauthConsentQueryOptions(context.runAuthed, params.id)),
  component: OAuthConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Authorization Request" />,
})
