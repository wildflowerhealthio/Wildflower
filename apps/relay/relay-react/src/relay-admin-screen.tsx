import { ErrorBanner, PageHeader, PageLoading } from '@wildflowerhealthio/react-tundraish'
import { Option } from 'effect'
import type { JSX } from 'react'

import { AdminKeyForm } from './admin-key-form.tsx'
import { CreateTunnelForm } from './create-tunnel-form.tsx'
import { useSignOutMutation, useStoredAdminKeyQuery } from './queries/index.ts'
import { TunnelList } from './tunnel-list.tsx'
import styles from './relay-admin-screen.module.css'

interface RelayAdminScreenProps {
  /** The admin site's host, `admin.<domain>`, named under the title. */
  readonly host: string
}

/** Signed in: create a tunnel, and the list of every tunnel. */
const SignedIn = (): JSX.Element => (
  <div className={styles['relay-admin-screen__signed-in']}>
    <CreateTunnelForm />
    <TunnelList />
  </div>
)

/**
 * The relay's admin site: the key form until this browser holds the admin key,
 * then the tunnels, with Sign out to drop the key.
 */
const RelayAdminScreen = ({ host }: RelayAdminScreenProps): JSX.Element => {
  const storedKey = useStoredAdminKeyQuery()
  const signOut = useSignOutMutation()
  const signedIn = storedKey.data?.pipe(Option.isSome) ?? false
  return (
    <main className={styles['relay-admin-screen']}>
      <PageHeader
        title="Relay admin"
        subtitle={host}
        actions={
          signedIn ? (
            <button
              type="button"
              className="button-2 outline"
              disabled={signOut.isPending}
              onClick={() => {
                signOut.mutate()
              }}
            >
              Sign out
            </button>
          ) : null
        }
      />
      <ErrorBanner error={signOut.error} />
      {storedKey.isPending ? <PageLoading /> : null}
      <ErrorBanner error={storedKey.error} />
      {(storedKey.data ?? Option.none()).pipe(
        Option.map(() => <SignedIn key="signed-in" />),
        Option.getOrElse(() => (storedKey.isSuccess ? <AdminKeyForm key="sign-in" /> : null))
      )}
    </main>
  )
}

export { RelayAdminScreen, type RelayAdminScreenProps }
