import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, PageHeader } from 'react-tundraish'

import { oauthConsentQueryOptions, useOAuthConsentQuery } from '../../../queries/index.ts'
import { OAuthConsentForm } from '../../../screens/oauth-consent/oauth-consent-form.tsx'

const OAuthConsentScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const navigate = useNavigate()
  const { data: consent } = useOAuthConsentQuery(id)
  return (
    <>
      <PageHeader title="Authorize App" />
      <OAuthConsentForm
        consent={consent}
        onDone={() => {
          void navigate({ to: '/settings/gatekeeper' })
        }}
      />
    </>
  )
}

/**
 * The `/gatekeeper/oauth-consent/$id` file route. Reads the typed `$id`
 * path param from the generated route via `Route.useParams()` and hands it
 * to the screen as a prop. The `_auth` `beforeLoad` gate guarantees a
 * token before this loader runs, so it's a plain `ensureQueryData` —
 * failures propagate to `errorComponent`.
 */
function OAuthConsentRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <OAuthConsentScreen id={id} />
}

export const Route = createFileRoute('/_auth/gatekeeper/oauth-consent/$id')({
  loader: ({ context, params }) =>
    context.queryClient.query({
      ...oauthConsentQueryOptions(context.runAuthed, params.id),
      staleTime: 'static',
    }),
  component: OAuthConsentRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Authorization Request" />,
})
