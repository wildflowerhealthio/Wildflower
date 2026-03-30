interface Sourced {
  meta: { source: string }
}

interface MaybeSourced {
  meta?: { source?: string }
}

export type { MaybeSourced, Sourced }
