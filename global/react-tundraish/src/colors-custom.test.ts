// The package's `types: []` keeps Node's globals out of the browser sources;
// this test reads the stylesheet off disk, so it opts in for itself alone.
/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

/**
 * The categorical series slots, as one list. Every expectation below is derived
 * from it, so a dropped token — or a fifth slot added without dark values —
 * fails rather than going unnoticed.
 */
const SERIES_SLOTS = [1, 2, 3, 4] as const

/** Status colours are reserved: a series slot never carries one of these. */
const STATUS_TOKENS = [
  '--color-success',
  '--color-success-background',
  '--color-success-foreground',
  '--color-success-border',
  '--color-warning',
  '--color-warning-background',
  '--color-warning-foreground',
  '--color-warning-border',
  '--color-red-5',
] as const

const LIGHT_SELECTOR = ':root'
const DARK_SELECTOR = ":root[data-color-scheme='dark']"

/**
 * The stylesheet's own text, read off disk rather than imported: under Vitest,
 * Vite's CSS plugin answers a `./colors-custom.css?raw` import with an empty
 * string, so every parse below would silently find nothing to check.
 */
const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'colors-custom.css'),
  'utf8'
)

describe('colors-custom.css series tokens', () => {
  it('should define every series token in the light palette', () => {
    // Arrange
    const light = customPropertiesOf(LIGHT_SELECTOR)

    // Act
    const missing = seriesTokenNames().filter((token) => !light.has(token))

    // Assert
    expect(missing).toEqual([])
  })

  it('should define every series token again in the dark palette', () => {
    // Arrange
    const dark = customPropertiesOf(DARK_SELECTOR)

    // Act
    const missing = seriesTokenNames().filter((token) => !dark.has(token))

    // Assert
    expect(missing).toEqual([])
  })

  it('should give each mode its own hex per slot', () => {
    // Arrange
    const light = customPropertiesOf(LIGHT_SELECTOR)
    const dark = customPropertiesOf(DARK_SELECTOR)

    // Act
    const shared = SERIES_SLOTS.map((slot) => `--color-series-${slot}`).filter(
      (token) => light.get(token) === dark.get(token)
    )

    // Assert — dark is a designed set stepped for the dark canvas, never the
    // light values re-used, so no slot may carry the same value in both modes.
    expect(shared).toEqual([])
  })

  it('should carry a validated hex in every slot', () => {
    for (const selector of [LIGHT_SELECTOR, DARK_SELECTOR]) {
      // Arrange
      const palette = customPropertiesOf(selector)

      // Act
      const notHex = SERIES_SLOTS.filter(
        (slot) => !/^#[0-9a-f]{6}$/.test(palette.get(`--color-series-${slot}`) ?? '')
      )

      // Assert — a slot is a literal hex the palette validator was run over,
      // not a `var()` alias that could drift when the aliased ramp is re-stepped.
      expect(notHex).toEqual([])
    }
  })

  it('should keep slot 1 on the navy accent step it documents', () => {
    for (const selector of [LIGHT_SELECTOR, DARK_SELECTOR]) {
      // Arrange
      const palette = customPropertiesOf(selector)

      // Act
      const accent = palette.get('--color-accent-5')

      // Assert — slot 1 spells the accent's base step out as a literal (the
      // validator is run over hexes, not `var()` chains), so the copy needs a
      // guard: re-stepping the accent ramp without re-validating slot 1 fails
      // here instead of drifting the chart off-brand.
      expect(accent).toMatch(/^#[0-9a-f]{6}$/)
      expect(palette.get('--color-series-1')).toBe(accent)
    }
  })

  it('should give every slot its own value within a mode', () => {
    for (const selector of [LIGHT_SELECTOR, DARK_SELECTOR]) {
      // Arrange
      const palette = customPropertiesOf(selector)

      // Act
      const values = SERIES_SLOTS.map((slot) => palette.get(`--color-series-${slot}`))

      // Assert — hue separation itself is the palette validator's job (CVD and
      // normal-vision ΔE); what the stylesheet can be held to is that no slot
      // was copy-pasted onto another.
      expect(new Set(values).size).toBe(SERIES_SLOTS.length)
    }
  })

  it('should never paint a series with a reserved status colour', () => {
    for (const selector of [LIGHT_SELECTOR, DARK_SELECTOR]) {
      // Arrange — dark redefines only part of the palette, so a dark surface
      // resolves the light values for everything it leaves alone.
      const palette =
        selector === DARK_SELECTOR
          ? new Map([...customPropertiesOf(LIGHT_SELECTOR), ...customPropertiesOf(DARK_SELECTOR)])
          : customPropertiesOf(LIGHT_SELECTOR)
      const unresolved = STATUS_TOKENS.filter((token) => palette.get(token) === undefined)
      const statusValues = new Set(STATUS_TOKENS.map((token) => palette.get(token)))

      // Act
      const collisions = SERIES_SLOTS.map((slot) => `--color-series-${slot}`).filter((token) =>
        statusValues.has(palette.get(token))
      )

      // Assert — a renamed or deleted status token would otherwise put
      // `undefined` in the set and quietly reduce this to a no-op, so the names
      // are checked before the values they stand for.
      expect(unresolved).toEqual([])
      expect(collisions).toEqual([])
    }
  })

  it('should mix each soft companion from its own slot', () => {
    for (const selector of [LIGHT_SELECTOR, DARK_SELECTOR]) {
      // Arrange
      const palette = customPropertiesOf(selector)

      // Act
      const notMixedFromOwnSlot = SERIES_SLOTS.filter((slot) => {
        const soft = palette.get(`--color-series-${slot}-soft`) ?? ''
        return !(soft.startsWith('color-mix(') && soft.includes(`var(--color-series-${slot})`))
      })

      // Assert — the band fill is derived from the slot it belongs to, so a
      // re-stepped slot carries its band with it.
      expect(notMixedFromOwnSlot).toEqual([])
    }
  })
})

// Helpers

/** Every series token name, both the marks and their band companions. */
const seriesTokenNames = (): string[] =>
  SERIES_SLOTS.flatMap((slot) => [`--color-series-${slot}`, `--color-series-${slot}-soft`])

/** The stylesheet with its comments removed, so a brace or a `--name:` inside
 * one can't be mistaken for a rule or a declaration. */
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The custom properties declared on `selector`, merged across every rule with
 * that exact selector — the light palette is split over two `:root` blocks, and
 * both are the same cascade target.
 */
const customPropertiesOf = (selector: string): Map<string, string> => {
  const declarations = new Map<string, string>()
  for (const body of ruleBodiesOf(withoutComments(source), selector)) {
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name !== undefined && value !== undefined) declarations.set(name, value.trim())
    }
  }
  return declarations
}

/** The bodies of every rule whose selector is exactly `selector`. */
const ruleBodiesOf = (css: string, selector: string): string[] => {
  const bodies: string[] = []
  for (let from = css.indexOf(selector); from !== -1; from = css.indexOf(selector, from + 1)) {
    const opening = css.indexOf('{', from)
    if (opening === -1) break
    // Anything between the match and the brace means the match was part of a
    // longer selector (`:root[data-color-scheme='dark'] button.outline`) or a
    // selector list, not a rule on `selector` alone.
    if (css.slice(from + selector.length, opening).trim() !== '') continue
    bodies.push(css.slice(opening + 1, closingBraceOf(css, opening)))
  }
  return bodies
}

/** The index of the `}` that closes the block opened at `opening`. */
const closingBraceOf = (css: string, opening: number): number => {
  let depth = 0
  for (let index = opening; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return css.length
}
