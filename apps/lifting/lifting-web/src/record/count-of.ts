/** `count` with the noun agreeing with it: `1 set`, `2 sets`. */
const countOf = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`

export { countOf }
