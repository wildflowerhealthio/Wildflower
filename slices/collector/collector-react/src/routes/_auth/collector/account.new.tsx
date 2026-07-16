import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CollectorTag, descriptors } from 'collector-registry/registry'
import { Schema } from 'effect'
import { unknownErrorToString } from 'kitchen-sink'
import type { JSX } from 'react'

import { AccountFormScreen } from '../../../forms/account-form.tsx'
import { useCreateRemoteMutation } from '../../../queries/index.ts'

/**
 * The `/collector/account/new` search: which collector to create (`tag`,
 * selecting the config form) plus an optional loose `prefill` bag the source
 * list hands off to seed fields. `prefill` is an untyped `Record<string,string>`
 * — each collector's form reads the keys it recognises and the screen reads
 * `name`; callers are trusted to populate sensible keys. `tag` defaults to the
 * first registered collector so a bare `/collector/account/new` still resolves.
 */
const AccountNewSearch = Schema.Struct({
  tag: Schema.optionalWith(CollectorTag, { default: (): CollectorTag => descriptors[0].tag }),
  prefill: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})
type AccountNewSearch = Schema.Schema.Type<typeof AccountNewSearch>

/**
 * The `/collector/account/new` route. `validateSearch` decodes the URL search
 * with `AccountNewSearch` at the router boundary; the component reads it back
 * through the generated, typed `Route.useSearch()` and delegates the whole
 * screen to the generic {@link AccountFormScreen}, wiring only the create
 * mutation and navigation.
 */
function AccountNewRoute(): JSX.Element {
  const { tag, prefill } = Route.useSearch()
  const navigate = useNavigate()
  const createMutation = useCreateRemoteMutation()
  const error = createMutation.error === null ? null : unknownErrorToString(createMutation.error)

  return (
    <AccountFormScreen
      title="Add Account"
      tag={tag}
      initial={undefined}
      prefill={prefill}
      initialName={prefill?.['name'] ?? ''}
      disabled={createMutation.isPending}
      error={error}
      onSubmit={(name, config) => {
        createMutation.mutate(
          { id: crypto.randomUUID(), name, config },
          {
            onSuccess: () => {
              void navigate({ to: '/collector' })
            },
          }
        )
      }}
      onCancel={() => {
        void navigate({ to: '/collector' })
      }}
    />
  )
}

const Route = createFileRoute('/_auth/collector/account/new')({
  validateSearch: Schema.standardSchemaV1(AccountNewSearch),
  component: AccountNewRoute,
})

export { AccountNewSearch, Route }
