/** `count` of `noun`, pluralised by adding `s`: `1 record`, `3 fields`. */
const countOf = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`

export { countOf }
