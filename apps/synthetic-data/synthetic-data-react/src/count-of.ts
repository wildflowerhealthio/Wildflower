/** `1 resource`, `2 resources`: `count` with `noun`, plural by `-s` unless `plural` is given. */
const countOf = (count: number, noun: string, plural = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : plural}`

export { countOf }
