import { createFileRoute } from '@tanstack/react-router'
import { ErrorBanner, TextField } from '@wildflowerhealthio/react-tundraish'
import type { ListedServer } from '@wildflowerhealthio/servers-core-js'
import { Option } from 'effect'
import { type JSX, useState } from 'react'

import { failureText } from '../../../failure-text.ts'
import { useUpdateServer } from '../../../queries.ts'
import {
  useDefaultAuthorizationUrl,
  useDefaultLauncherUrl,
  useRunHostCommand,
} from '../../../router-context.ts'
import { useListedServer } from './-listed-server.ts'
import styles from './-default-apps.module.css'

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

/** A {@link PageUrlForm}'s state and what it can do. */
interface PageUrlFormState {
  /** The URL in the field. */
  readonly url: string
  readonly setUrl: (url: string) => void
  /** Whether the field differs from the saved URL, so there is something to save. */
  readonly changed: boolean
  /** Whether the saved URL is the default, compared as URLs, so there is nothing to reset. */
  readonly isDefault: boolean
  /** Whether a save is in flight. */
  readonly isSaving: boolean
  /** The host's refusal of the latest save. */
  readonly failure: Option.Option<string>
  /** Saves the URL in the field. */
  readonly save: () => void
  /** Puts the default in the field and saves it at once. */
  readonly resetToDefault: () => void
}

/**
 * The state of the form that edits `server`'s `field`, starting at the saved
 * URL, and its saves: each sends the server's other page and its certificate
 * authority unchanged.
 */
const usePageUrlForm = (
  server: ListedServer.Type,
  field: PageUrlField,
  defaultUrl: string
): PageUrlFormState => {
  const updateServer = useUpdateServer(useRunHostCommand())
  const [url, setUrl] = useState(server[field])
  const saveUrl = (saved: string): void => {
    updateServer.mutate({
      domain: server.domain,
      launcherUrl: server.launcherUrl,
      authorizationUrl: server.authorizationUrl,
      certificateAuthority: server.certificateAuthority,
      [field]: saved,
    })
  }
  return {
    url,
    setUrl,
    changed: url !== server[field],
    isDefault: isDefaultUrl(server[field], defaultUrl),
    isSaving: updateServer.isPending,
    failure: Option.fromNullable(updateServer.error).pipe(Option.map(failureText)),
    save: () => {
      saveUrl(url)
    },
    resetToDefault: () => {
      setUrl(defaultUrl)
      saveUrl(defaultUrl)
    },
  }
}

/**
 * One of the pages the server opens, its launcher or its Authorization app
 * (see {@link usePageUrlForm}): a field starting at the saved URL, Save once
 * it is changed, and, while the saved URL isn't `defaultUrl`, the one the
 * host gives a new server, Reset to default, which saves the default at
 * once, named for its field (`resetLabel`) so the tab's two resets are told
 * apart. The host's refusal shows under the field.
 */
const PageUrlForm = ({
  server,
  field,
  defaultUrl,
}: {
  readonly server: ListedServer.Type
  readonly field: PageUrlField
  readonly defaultUrl: string
}): JSX.Element => {
  const form = usePageUrlForm(server, field, defaultUrl)
  const { label, description, saveLabel, resetLabel } = PAGE_URL_COPY[field]
  return (
    <form
      className={styles['default-apps__form']}
      onSubmit={(event) => {
        event.preventDefault()
        form.save()
      }}
    >
      <TextField
        label={label}
        type="url"
        inputMode="url"
        value={form.url}
        onChange={form.setUrl}
        description={description}
      />
      <ErrorBanner error={Option.getOrNull(form.failure)} />
      <div className={styles['default-apps__form-actions']}>
        <button
          type="submit"
          className={`button-2 outline ${styles['default-apps__form-action']}`}
          disabled={!form.changed || form.isSaving}
        >
          {saveLabel}
        </button>
        {form.isDefault ? null : (
          <button
            type="button"
            className={`button-2 ghost ${styles['default-apps__form-action']}`}
            disabled={form.isSaving}
            aria-label={resetLabel}
            onClick={form.resetToDefault}
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
  return (
    <>
      <PageUrlForm server={server} field="launcherUrl" defaultUrl={useDefaultLauncherUrl()} />
      <PageUrlForm
        server={server}
        field="authorizationUrl"
        defaultUrl={useDefaultAuthorizationUrl()}
      />
    </>
  )
}

export const Route = createFileRoute('/servers/$domain/default-apps')({
  component: ServerDefaultAppsTab,
})
