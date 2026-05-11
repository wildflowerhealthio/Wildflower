interface Open {
  readonly _tag: 'Open'
  readonly href: string
}

interface Click {
  readonly _tag: 'Click'
  readonly querySelector: string
}

type Any = Open | Click

export type { Open, Click, Any }
