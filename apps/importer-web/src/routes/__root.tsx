import { createRootRouteWithContext, Link, useMatches } from '@tanstack/react-router'
import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { RouteTabs } from '@wildflowerhealthio/react-tundraish'
import { walkthroughAnchor } from '@wildflowerhealthio/walkthrough-core'
import { Option } from 'effect'
import type { JSX } from 'react'

import type { RouterContext } from '../router.ts'
import { ImporterNotFound } from './-importer-not-found.tsx'
import {
  ImporterPageWalkthroughAnchor,
  SHOW_WALKTHROUGH_AGAIN_SEARCH,
} from './import/-import-walkthrough.ts'
import styles from './-importer-page.module.css'

/**
 * The subtitle the open tab's route names in its `staticData`, or none while
 * no tab is open (the bare path, on its way to a redirect).
 */
const useOpenTabSubtitle = (): Option.Option<string> =>
  Option.fromNullable(useMatches({ select: (matches) => matches.at(-1)?.staticData.subtitle }))

/**
 * The importer page: its title, with what the open tab does under it, over
 * the tabs, each a child route the strip links to: Import, which files a
 * capture's records into the FHIR server; Anonymize, which pseudonymizes a
 * capture for download.
 *
 * @remarks
 * **This app renders no importing or anonymizing surface of its own.** Each tab
 * mounts one slice screen (`ImporterScreen` / `AnonymizerScreen`) that owns
 * every level below it — source pick, preview, confirm/download, results. The
 * page owns the tab strip and the header copy, nothing else; see the traps in
 * [AGENTS.md](../../AGENTS.md) for why splitting a flow across the app boundary
 * is the mistake this shape exists to avoid.
 *
 * The unselected tab's route is not matched, so its screen is **unmounted**,
 * not hidden: an accessibility tree only carries the surface the user is on,
 * and the screen holds its own state, so a flip-back opens fresh at the picker.
 *
 * The app has no settings or menu, so the footer under the tabs holds Show
 * walkthrough again, which opens the Import tab with `?walkthrough=show`
 * (`import/-import-walkthrough.ts`).
 */
function ImporterPage(): JSX.Element {
  const subtitle = useOpenTabSubtitle()
  return (
    <>
      <header className={styles['importer-page__header']}>
        <h1 className="text-heading-3">Importer</h1>
        {subtitle.pipe(
          Option.map((text) => (
            <p key="subtitle" className={cn(styles['importer-page__subtitle'], 'text-body-3')}>
              {text}
            </p>
          )),
          Option.getOrNull
        )}
      </header>
      <RouteTabs
        tabs={[
          {
            to: '/import',
            label: 'Import',
            ...walkthroughAnchor(ImporterPageWalkthroughAnchor.importTab),
          },
          {
            to: '/anonymize',
            label: 'Anonymize',
            ...walkthroughAnchor(ImporterPageWalkthroughAnchor.anonymizeTab),
          },
        ]}
        aria-label="Importer views"
      />
      <footer className={styles['importer-page__footer']}>
        <Link
          to="/import"
          search={SHOW_WALKTHROUGH_AGAIN_SEARCH}
          className="text-body-3"
          {...walkthroughAnchor(ImporterPageWalkthroughAnchor.showAgain)}
        >
          Show walkthrough again
        </Link>
      </footer>
    </>
  )
}

/**
 * The root route: the importer page, each of whose tabs is a child route, and
 * in the tab panel for a path no tab names, the not-found card.
 */
const Route = createRootRouteWithContext<RouterContext>()({
  component: ImporterPage,
  notFoundComponent: ImporterNotFound,
})

export { Route }
