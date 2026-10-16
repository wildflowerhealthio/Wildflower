import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import golden from '../../../../../servers-wire-golden.json' with { type: 'json' }
import {
  type FakeEvents,
  type FakeHealth,
  type FakeHost,
  fakeEvents,
  fakeHealth,
  hostWith,
} from '../../../test-utils/host-fakes.ts'
import { renderBase, storageAnswered } from '../../../test-utils/render-base.ts'

/** A `/health` check object as a server serves it. */
const healthCheck = (status: string): Readonly<Record<string, string>> => ({
  componentType: 'system',
  status,
  time: '2026-10-06T17:01:00Z',
})

/** A passing `/health` report, with a check for each of the server's components. */
const passingReport = {
  status: 'pass',
  checks: {
    server: [healthCheck('pass')],
    connectivity: [healthCheck('pass')],
    'fhir-r4': [healthCheck('pass')],
  },
}

/**
 * `golden.listedServers` with ruth's status set to `status`, and its
 * certificate to the status's, as `servers_list` lists it.
 */
const listedWithRuthStatus = (status: { readonly certificate: unknown }): readonly unknown[] => [
  { ...golden.listedServers[0], status, certificate: status.certificate },
  golden.listedServers[1],
]

/**
 * Render the page of the server `domain` on a host listing `servers`, with
 * `/health` answered by `health`: at its bare path, or at the child route
 * `tab` names.
 */
const renderServerPage = ({
  domain,
  tab,
  servers = golden.listedServers,
  answers = {},
  health = fakeHealth(() => Response.json(passingReport)),
  events = fakeEvents(),
}: {
  readonly domain: string
  readonly tab?: string
  readonly servers?: readonly unknown[]
  readonly answers?: Readonly<Record<string, () => Promise<unknown>>>
  readonly health?: FakeHealth
  readonly events?: FakeEvents
}): FakeHost => {
  const host = hostWith({ servers: () => Promise.resolve(servers), answers })
  renderBase({
    invoke: host.invoke,
    storage: storageAnswered({ crashReports: false, performance: false }),
    path: tab === undefined ? `/servers/${domain}` : `/servers/${domain}/${tab}`,
    events,
    httpClient: health.layer,
  })
  return host
}

/** The page's status hero. */
const hero = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Status' })

/** The hero's status badge: the last of its live regions, after the copy announcement. */
const heroBadge = async (): Promise<HTMLElement> => {
  const badge = within(await hero())
    .getAllByRole('status')
    .at(-1)
  if (badge === undefined) throw new Error('the hero has no status badge')
  return badge
}

/** The section of the list or form titled `title`. */
const sectionTitled = (title: string): HTMLElement => {
  const section = screen.getByRole('heading', { name: title }).closest('section')
  if (section === null) throw new Error(`no ${title} section`)
  return section
}

/** The server page's tab strip. */
const tabStrip = (): Promise<HTMLElement> =>
  screen.findByRole('navigation', { name: 'Server details' })

/** The name of the server page's open tab, once the page has opened one. */
const openTabName = async (): Promise<string | null> =>
  waitFor(async () => {
    const current = (await tabStrip()).querySelector('[aria-current="page"]')
    if (current === null) throw new Error('no tab is open')
    return current.textContent
  })

/** Open the server page's tab named `name`. */
const openTab = async (name: string): Promise<void> => {
  await userEvent.click(within(await tabStrip()).getByRole('link', { name }))
}

export {
  healthCheck,
  hero,
  heroBadge,
  listedWithRuthStatus,
  openTab,
  openTabName,
  passingReport,
  renderServerPage,
  sectionTitled,
}
