import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vite-plus/test'

import { excerpt, ExcerptError, type Excerpt, type ExcerptOptions } from './excerpt.ts'
import { ItemNotFound } from './item-not-found.ts'
import { locateRustItem } from './rust-items.ts'
import { locateTypeScriptItem } from './typescript-items.ts'

const fixtures = join(import.meta.dirname, 'fixtures')
const rust = readFileSync(join(fixtures, 'sample-crate/src/lib.rs'), 'utf8')
const typescript = readFileSync(join(fixtures, 'sample-ts/sample.ts'), 'utf8')

const WHOLE: ExcerptOptions = { fragments: [], keepDocs: false }

const rustExcerpt = async (symbol: string, options: ExcerptOptions = WHOLE): Promise<Excerpt> =>
  excerpt(rust, await locateRustItem(rust, symbol), options)

const tsExcerpt = (symbol: string, options: ExcerptOptions = WHOLE): Excerpt =>
  excerpt(typescript, locateTypeScriptItem('sample.ts', typescript, symbol), options)

describe('Rust items', () => {
  it('shows an item without its doc comments and attributes, inside or before it', async () => {
    const shown = await rustExcerpt('Outcome')
    expect(shown.text).toBe('pub enum Outcome {\n    Approved,\n    Denied,\n}')
    expect([shown.firstRow + 1, shown.lastRow + 1]).toEqual([5, 10])
  })

  it('keeps doc comments when asked, but never attributes', async () => {
    const shown = await rustExcerpt('Outcome', { fragments: [], keepDocs: true })
    expect(shown.text).toBe(
      'pub enum Outcome {\n    /// It was approved.\n    Approved,\n    Denied,\n}'
    )
  })

  it('finds consts and top-level functions', async () => {
    expect((await rustExcerpt('LIMIT')).text).toBe('pub const LIMIT: u32 = 3;')
    expect((await rustExcerpt('helper')).text).toBe('fn helper() -> u32 {\n    2\n}')
  })

  it('finds an inherent method through a generic impl, re-indented, keeping ordinary comments', async () => {
    const shown = await rustExcerpt('Counter::bump')
    expect(shown.text.split('\n').slice(0, 3)).toEqual([
      'pub fn bump(&mut self) -> Result<u32, Outcome> {',
      '    // Stop at the limit.',
      '    if self.count >= LIMIT {',
    ])
  })

  it('finds an item inside a module', async () => {
    expect((await rustExcerpt('nested::helper')).text).toBe('pub fn helper() -> u32 {\n    1\n}')
  })

  it('finds a default method in a trait', async () => {
    expect((await rustExcerpt('Named::name')).text).toContain('String::from("unnamed")')
  })

  it('refuses a method two trait impls define, and takes the qualified form', async () => {
    await expect(locateRustItem(rust, 'Counter::reset')).rejects.toThrow(
      /Counter::reset is ambiguous: it names the items at lines 51, 57/
    )
    expect((await rustExcerpt('<Counter as Resettable>::reset')).text).toContain(
      'self.count = LIMIT;'
    )
  })

  it('finds a function in a `proptest!` block, without its doc comment, attribute or the block’s config', async () => {
    const shown = await rustExcerpt('doubling_is_even')
    expect(shown.text).toBe(
      'fn doubling_is_even(n in 0u32..100) {\n    prop_assert_eq!((n * 2) % 2, 0);\n}'
    )
    expect(shown.firstRow + 1).toBe(
      rust.split('\n').indexOf('    fn doubling_is_even(n in 0u32..100) {') + 1
    )
  })

  it('finds a function in a module’s `proptest!` block, and fragments of it', async () => {
    const shown = await rustExcerpt('tests::bump_stays_within_the_limit')
    expect(shown.text.split('\n')[0]).toBe(
      'fn bump_stays_within_the_limit(steps in 0usize..10, tag in "é[a-z]{0,4}") {'
    )
    expect(shown.text.split('\n').at(-1)).toBe('}')
    expect((await rustExcerpt('tests::new_starts_at_zero')).text).toBe(
      'fn new_starts_at_zero(tag in any::<u8>()) {\n    prop_assert_eq!(super::Counter::new(tag).count, 0);\n}'
    )
    const loop = await rustExcerpt('tests::bump_stays_within_the_limit', {
      fragments: [{ from: 'for _ in' }],
      keepDocs: false,
    })
    expect(loop.text).toBe('for _ in 0..steps {\n    let _ = counter.bump();\n}')
  })

  it('refuses a name nothing declares', async () => {
    await expect(locateRustItem(rust, 'Counter::missing')).rejects.toThrow(ItemNotFound)
    await expect(locateRustItem(rust, 'Missing')).rejects.toThrow('no Rust item named Missing')
  })
})

describe('fragments', () => {
  it('runs from the line holding `from` to the line holding `to`', async () => {
    const shown = await rustExcerpt('Counter::bump', {
      fragments: [{ from: 'if self.count', end: { kind: 'to', text: 'return Err' } }],
      keepDocs: false,
    })
    expect(shown.text).toBe('if self.count >= LIMIT {\n    return Err(Outcome::Denied);')
  })

  it('takes the whole statement beginning on the `through` line, or on the `from` line alone', async () => {
    const through = await rustExcerpt('Counter::bump', {
      fragments: [
        { from: '// Stop at the limit.', end: { kind: 'through', text: 'if self.count' } },
      ],
      keepDocs: false,
    })
    expect(through.text).toBe(
      '// Stop at the limit.\nif self.count >= LIMIT {\n    return Err(Outcome::Denied);\n}'
    )
    const statement = await rustExcerpt('Counter::bump', {
      fragments: [{ from: 'let next' }],
      keepDocs: false,
    })
    expect(statement.text).toBe(
      'let next = self\n    .count\n    .checked_mul(2)\n    .unwrap_or(0);'
    )
  })

  it('takes the whole item from a `from` alone on its first line', async () => {
    const whole = await rustExcerpt('Counter::bump')
    const fromSignature = await rustExcerpt('Counter::bump', {
      fragments: [{ from: 'pub fn bump' }],
      keepDocs: false,
    })
    expect(fromSignature).toEqual(whole)
    expect(
      tsExcerpt('twice', { fragments: [{ from: 'function twice' }], keepDocs: false })
    ).toEqual(tsExcerpt('twice'))
  })

  it('marks skipped lines with `// …` at the next line’s indentation', async () => {
    const shown = await rustExcerpt('Counter::bump', {
      fragments: [
        { from: 'if self.count', end: { kind: 'to', text: 'return Err' } },
        { from: 'Ok(next)' },
      ],
      keepDocs: false,
    })
    expect(shown.text).toBe(
      'if self.count >= LIMIT {\n    return Err(Outcome::Denied);\n// …\nOk(next)'
    )
    expect([shown.firstRow + 1, shown.lastRow + 1]).toEqual([27, 35])
  })

  it('fails on text no line of the item holds', async () => {
    await expect(
      rustExcerpt('Counter::bump', { fragments: [{ from: 'not in the item' }], keepDocs: false })
    ).rejects.toThrow(ExcerptError)
    await expect(
      rustExcerpt('Counter::bump', {
        fragments: [{ from: 'let next', end: { kind: 'to', text: '// Stop' } }],
        keepDocs: false,
      })
    ).rejects.toThrow(/to="\/\/ Stop" matches no line/)
  })
})

describe('TypeScript items', () => {
  it('finds a top-level const without its doc comment', () => {
    expect(tsExcerpt('LIMIT').text).toBe('const LIMIT = 3')
  })

  it('finds a class member', () => {
    expect(tsExcerpt('Counter.bump').text).toBe(
      'bump(): number {\n  // Stop at the limit.\n  if (this.count >= LIMIT) return this.count\n  this.count += 1\n  return this.count\n}'
    )
  })

  it('finds an interface without its members’ doc comments', () => {
    expect(tsExcerpt('Shape').text).toBe('interface Shape {\n  readonly area: number\n}')
  })

  it('finds a declaration in a namespace, and a statement from `from` alone', () => {
    expect(tsExcerpt('Shapes.square').text).toBe(
      'export const square = (side: number): Shape => ({\n  area: side * side,\n})'
    )
    expect(tsExcerpt('twice', { fragments: [{ from: 'return' }], keepDocs: false }).text).toBe(
      'return value * 2'
    )
  })

  it('takes a value over the type alias derived from it', () => {
    expect(tsExcerpt('Point').text).toBe('const Point = { x: 0, y: 0 }')
  })

  it('refuses a name nothing declares', () => {
    expect(() => locateTypeScriptItem('sample.ts', typescript, 'Counter.missing')).toThrow(
      'no TypeScript item named Counter.missing'
    )
  })
})
