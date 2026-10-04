/** Options for the request-log hooks a live surface polls. */
interface LiveQueryOptions {
  /** Re-read every this many milliseconds; left out, the read isn't polled. */
  readonly refetchInterval?: number
}

export type { LiveQueryOptions }
