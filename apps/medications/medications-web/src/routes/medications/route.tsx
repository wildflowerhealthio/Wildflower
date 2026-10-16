import { createFileRoute } from '@tanstack/react-router'
import { MedicationsView } from '@wildflowerhealthio/medication-sponsorship-react'
import { LoadingMoreLine, ReadFailureLine } from '@wildflowerhealthio/smart-app-react'
import { type JSX, type RefObject, useEffect, useRef } from 'react'

import { type MedicationRead, useMedicationRead } from '../-medication-read.ts'

/**
 * A bottom-of-list sentinel that pulls the read's next page as it scrolls
 * into view, so pages load on demand instead of all at once.
 *
 * @remarks
 * The effect only builds an `IntersectionObserver` while there is a next
 * page, so a fully loaded list never touches it.
 */
const useNextPageSentinel = ({
  pagedQuery: { hasNextPage, isFetchingNextPage, fetchNextPage },
}: MedicationRead): RefObject<HTMLDivElement | null> => {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || !hasNextPage) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
        void fetchNextPage()
      }
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  return sentinelRef
}

/**
 * The Medications tab: the list, with sponsorship chips, growing a page at a
 * time as its end scrolls into view. A failed later page keeps the rows
 * already loaded and shows an inline line beneath them.
 */
function MedicationsTab(): JSX.Element {
  const read = useMedicationRead()
  const sentinelRef = useNextPageSentinel(read)
  const { pagedQuery, views } = read
  return (
    <>
      <MedicationsView medications={views} />
      {pagedQuery.isFetchingNextPage && <LoadingMoreLine />}
      {pagedQuery.isFetchNextPageError && (
        <ReadFailureLine subject="medications" error={pagedQuery.error} />
      )}
      {pagedQuery.hasNextPage && <div ref={sentinelRef} aria-hidden="true" />}
    </>
  )
}

/** `/medications`, the Medications tab, which the page opens on. */
const Route = createFileRoute('/medications')({
  component: MedicationsTab,
})

export { Route }
