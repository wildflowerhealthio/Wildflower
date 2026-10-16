import { useRouteContext } from '@tanstack/react-router'
import { ErrorBanner, TextField } from '@wildflowerhealthio/react-tundraish'
import type { ListedServer } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import { type JSX, useState } from 'react'

import { failureText } from './failure-text.ts'
import { useListedServer } from './listed-server-context.ts'
import { useUpdateServer } from './queries.ts'
import type { RouterContext, RunHostCommand } from './router-context.ts'
import styles from './server-default-apps-tab.module.css'

/** A URL as the URL parser normalises it, or nothing when it doesn't parse. */
const normalisedUrl = (url: string): Option.Option<string> =>
  URL.canParse(url) ? Option.some(new URL(url).href) : Option.none()

/**
 * Whether `url` is `defaultUrl`, compared as URLs, so a spelling the parser
 * normalises (a host's case, a default port) still matches; a URL or default
 * that doesn't parse matches nothing.
 */
const isDefaultUrl = (url: string, defaultUrl: string): boolean =>
  Option.all([normalisedUrl(url), normalisedUrl(defaultUrl)]).pipe(
    Option.exists(([parsed, parsedDefault]) => parsed === parsedDefault)
  )

/** Which of a server's page URLs a {@link PageUrlForm} edits. */
type PageUrlField = 'launcherUrl' | 'authorizationUrl'

/** How a {@link PageUrlForm} names its field, for each of the page URLs. */
const PAGE_URL_COPY: Readonly<
  Record<
    PageUrlField,
    { label: string; description: string; saveLabel: string; resetLabel: string }
  >
> = {
  launcherUrl: {
    label: 'Launcher',
    description: "The page this server's apps are launched from.",
    saveLabel: 'Save Launcher URL',
    resetLabel: 'Reset Launcher URL to default',
  },
  authorizationUrl: {
    label: 'Authorization',
    description: 'The Wildflower Authorization app this server opens.',
    saveLabel: 'Save Authorization Manager URL',
    resetLabel: 'Reset Authorization Manager URL to default',
  },
}

/**
 * One of the pages the server opens, its launcher or its Authorization app:
 * a field starting at the saved URL, Save once it is changed, and, while the
 * saved URL isn't `defaultUrl`, the one the host gives a new server, compared
 * as URLs, Reset to default, which saves the default at once, named for its
 * field (`resetLabel`) so the tab's two resets are told apart. The server's
 * other page and its certificate authority are saved unchanged, and the
 * host's refusal shows under the field.
 */
const PageUrlForm = ({
  server,
  field,
  defaultUrl,
  runHostCommand,
}: {
  readonly server: ListedServer.Type
  readonly field: PageUrlField
  readonly defaultUrl: string
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const updateServer = useUpdateServer(runHostCommand)
  const [url, setUrl] = useState(server[field])
  const { label, description, saveLabel, resetLabel } = PAGE_URL_COPY[field]
  const save = (saved: string): void => {
    updateServer.mutate({
      domain: server.domain,
      launcherUrl: server.launcherUrl,
      authorizationUrl: server.authorizationUrl,
      certificateAuthority: server.certificateAuthority,
      [field]: saved,
    })
  }
  return (
    <form
      className={styles['server-default-apps-tab__form']}
      onSubmit={(event) => {
        event.preventDefault()
        save(url)
      }}
    >
      <TextField
        label={label}
        type="url"
        inputMode="url"
        value={url}
        onChange={setUrl}
        description={description}
      />
      <ErrorBanner error={updateServer.error === null ? null : failureText(updateServer.error)} />
      <div className={styles['server-default-apps-tab__form-actions']}>
        <button
          type="submit"
          className={`button-2 outline ${styles['server-default-apps-tab__form-action']}`}
          disabled={url === server[field] || updateServer.isPending}
        >
          {saveLabel}
        </button>
        {isDefaultUrl(server[field], defaultUrl) ? null : (
          <button
            type="button"
            className={`button-2 ghost ${styles['server-default-apps-tab__form-action']}`}
            disabled={updateServer.isPending}
            aria-label={resetLabel}
            onClick={() => {
              setUrl(defaultUrl)
              save(defaultUrl)
            }}
          >
            Reset to default
          </button>
        )}
      </div>
    </form>
  )
}

/**
 * The server page's Default Apps tab, `/servers/$domain/default-apps`: the
 * pages the server opens, its launcher and its Authorization app, each with
 * the default the host gives a new server.
 */
const ServerDefaultAppsTab = (): JSX.Element => {
  const server = useListedServer()
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const defaultLauncherUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.defaultLauncherUrl,
  })
  const defaultAuthorizationUrl = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.defaultAuthorizationUrl,
  })
  return (
    <>
      <PageUrlForm
        server={server}
        field="launcherUrl"
        defaultUrl={defaultLauncherUrl}
        runHostCommand={runHostCommand}
      />
      <PageUrlForm
        server={server}
        field="authorizationUrl"
        defaultUrl={defaultAuthorizationUrl}
        runHostCommand={runHostCommand}
      />
    </>
  )
}

export { ServerDefaultAppsTab }
