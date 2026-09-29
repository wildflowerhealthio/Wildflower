/** `noun` singular when `count` is 1, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

export { plural }
