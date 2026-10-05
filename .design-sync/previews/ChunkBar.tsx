import { useEffect, useRef } from 'react'
import { ChunkBar } from 'react-tundraish'

/** Pages arrived by scrolling; no fetch running. One block per page. */
export const Idle = () => <ChunkBar phase="idle" pagesReceived={8} loadedCount={400} onLoadAll={() => {}} />

/** A load-everything fetch in progress — the in-flight block breathes at the tail. */
export const Loading = () => <ChunkBar phase="loading" pagesReceived={12} loadedCount={600} />

/** Every page arrived — the gaps collapse and the blocks combine into one bar. */
export const Locked = () => <ChunkBar phase="locked" pagesReceived={16} loadedCount={784} />

/** A page failed — the bar enters its error phase. */
export const Failed = () => <ChunkBar phase="error" pagesReceived={9} loadedCount={450} onLoadAll={() => {}} />

/** Past 24 pages the blocks tighten; every 20 the bar wraps to a new row. */
export const Dense = () => <ChunkBar phase="loading" pagesReceived={46} loadedCount={2300} />

/**
 * The hover/focus tooltip, opened on mount (tapping the bar opens it): the
 * exact loaded count and the load-everything link action.
 */
export const WithTooltip = () => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="img"]')?.click()
  }, [])
  return (
    <div ref={ref} style={{ minHeight: 140 }}>
      <ChunkBar
        phase="idle"
        pagesReceived={6}
        loadedCount={312}
        onLoadAll={() => {}}
        labels={{ countSuffix: 'medication requests have been loaded.' }}
      />
    </div>
  )
}
