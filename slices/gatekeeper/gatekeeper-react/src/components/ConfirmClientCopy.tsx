import {
  CLIENT_BASE_URL_PARAM,
  pageOnClientCopy,
  parseClientBaseUrl,
} from 'gatekeeper-core/smart-client'
import { useMemo, useState, type JSX, type ReactNode } from 'react'

import pageLayout from '../styles/page-layout.module.css'

interface ConfirmClientCopyProps {
  /** The owner-UI route this page is (e.g. `/gatekeeper/devices`). */
  readonly route: string
  /** This page's query string, which may carry `CLIENT_BASE_URL_PARAM`. */
  readonly search: string
  /** The page itself, shown once the Owner stays here. */
  readonly children: ReactNode
}

/**
 * Asks the Owner before a sign-in page continues on another copy of the owner
 * UI. The server lands a first-party client's sign-in page here, on the
 * configured copy, and names the copy the client asked for as
 * `CLIENT_BASE_URL_PARAM` when none of the client's registered redirects
 * vouches for it — the request that named it is unauthenticated, so a crafted
 * link could name any page. "Continue there" opens the same page on that copy;
 * "Stay here" shows `children`. See "Client base URL" in the gatekeeper
 * Jargon Explanation.
 *
 * A value that isn't an absolute `http`/`https` URL came from no server, so it
 * is not offered as a link: the page renders as if no copy were named.
 */
const ConfirmClientCopy = ({ route, search, children }: ConfirmClientCopyProps): JSX.Element => {
  const clientBase = useMemo(() => {
    const raw = new URLSearchParams(search).get(CLIENT_BASE_URL_PARAM)
    return raw === null ? undefined : parseClientBaseUrl(raw)
  }, [search])
  const [stayed, setStayed] = useState(false)

  if (clientBase === undefined || stayed) return <>{children}</>

  return (
    <div className={pageLayout['section']}>
      <h1 className="text-heading-6">Continue on another copy of Wildflower?</h1>
      <p className="text-body-2">
        This sign-in asked to continue on <code>{clientBase.href}</code>, which hasn’t been approved
        on this server before. Continue there only if you started this sign-in from that address.
      </p>
      <div className={pageLayout['buttons']}>
        <a className="button-2 filled" href={pageOnClientCopy(clientBase, route, search)}>
          Continue there
        </a>
        <button
          type="button"
          className="button-2"
          onClick={() => {
            setStayed(true)
          }}
        >
          Stay here
        </button>
      </div>
    </div>
  )
}

export { ConfirmClientCopy }
