import { useLocation } from '@tanstack/react-router'
import { PageHeader, pageLayoutStyles } from '@wildflowerhealthio/react-tundraish'
import type { JSX } from 'react'

/**
 * The page for a path no route of the host's or the base's names, under the
 * Servers | Recorder bar, which leads back.
 */
function HostNotFound(): JSX.Element {
  const pathname = useLocation({ select: (location) => location.pathname })
  return (
    <div className={pageLayoutStyles['page']}>
      <PageHeader title="Page not found" />
      <p>Wildflower Host has no page at {pathname}.</p>
    </div>
  )
}

export { HostNotFound }
