// Cuts an item's lines down to what a chapter shows: the fragments a
// directive names, without the doc comments and attributes the prose
// replaces, re-indented to the left margin. Language-neutral: a language's
// resolver (`rust-items.ts`, `typescript-items.ts`) finds the item and says
// which rows to strip and where a statement ends.

/** Rows are 0-based throughout; links add 1. */
interface LocatedItem {
  /** The item's first row, after any doc comments and attributes before it. */
  readonly startRow: number
  /** The item's last row, inclusive. */
  readonly endRow: number
  /** Rows inside the item holding only a doc comment. */
  readonly docRows: ReadonlySet<number>
  /** Rows inside the item holding only an attribute (`#[…]`). */
  readonly attributeRows: ReadonlySet<number>
  /**
   * The last row of the outermost statement or expression that begins at
   * `row`'s first non-blank character; `row` itself when none does.
   */
  readonly statementEndRow: (row: number) => number
}

/** One `from=` and what ends it. */
interface Fragment {
  readonly from: string
  /** The fragment ends on the first line from `from` on holding `text`; with `through`, it goes on to the end of the statement beginning there. */
  readonly end?: { readonly kind: 'to' | 'through'; readonly text: string }
}

interface ExcerptOptions {
  readonly fragments: readonly Fragment[]
  readonly keepDocs: boolean
}

interface Excerpt {
  readonly text: string
  /** The first and last source rows shown, for the link to them. */
  readonly firstRow: number
  readonly lastRow: number
}

/** A fragment's text matched no line, or the excerpt came out empty. */
class ExcerptError extends Error {}

/** The line the elided rows between two fragments become. */
const ELISION = '// …'

const indentOf = (line: string): number => line.length - line.trimStart().length

const findRow = (lines: readonly string[], text: string, from: number, to: number): number => {
  for (let row = from; row <= to; row++) if (lines[row].includes(text)) return row
  return -1
}

/** The row ranges, inclusive, the fragments select within the item. */
const selectRanges = (
  lines: readonly string[],
  item: LocatedItem,
  fragments: readonly Fragment[]
): readonly (readonly [number, number])[] => {
  if (fragments.length === 0) return [[item.startRow, item.endRow]]
  const ranges: [number, number][] = []
  let searchFrom = item.startRow
  for (const fragment of fragments) {
    const start = findRow(lines, fragment.from, searchFrom, item.endRow)
    if (start < 0)
      throw new ExcerptError(
        `from="${fragment.from}" matches no line of the item from line ${searchFrom + 1} on`
      )
    let end: number
    if (fragment.end === undefined) {
      end = item.statementEndRow(start)
    } else {
      const endRow = findRow(lines, fragment.end.text, start, item.endRow)
      if (endRow < 0)
        throw new ExcerptError(
          `${fragment.end.kind}="${fragment.end.text}" matches no line of the item from from="${fragment.from}" on`
        )
      end = fragment.end.kind === 'through' ? item.statementEndRow(endRow) : endRow
    }
    ranges.push([start, Math.min(end, item.endRow)])
    searchFrom = end + 1
  }
  return ranges
}

/**
 * `item`'s source as a chapter shows it: the rows its fragments select (all
 * of it without any), doc comments (unless `keepDocs`) and attributes left
 * out, `// …` where fragments skip rows, and the common indentation removed.
 */
const excerpt = (source: string, item: LocatedItem, options: ExcerptOptions): Excerpt => {
  const lines = source.split('\n')
  const ranges = selectRanges(lines, item, options.fragments)
  const dropped = (row: number): boolean =>
    item.attributeRows.has(row) || (!options.keepDocs && item.docRows.has(row))
  // Each kept line, and null where an elision goes.
  const kept: (string | null)[] = []
  ranges.forEach(([start, end], index) => {
    const previousEnd = index > 0 ? ranges[index - 1][1] : undefined
    if (previousEnd !== undefined && start > previousEnd + 1) kept.push(null)
    for (let row = start; row <= end; row++) if (!dropped(row)) kept.push(lines[row])
  })
  const nonBlank = kept.filter((line): line is string => line !== null && line.trim() !== '')
  if (nonBlank.length === 0) throw new ExcerptError('the excerpt is empty')
  const margin = Math.min(...nonBlank.map(indentOf))
  const out = kept.map((line, index) => {
    if (line !== null) return line.trim() === '' ? '' : line.slice(margin)
    const next = kept.slice(index + 1).find((l): l is string => l !== null && l.trim() !== '')
    return `${' '.repeat(Math.max(0, (next === undefined ? margin : indentOf(next)) - margin))}${ELISION}`
  })
  return {
    text: out.join('\n'),
    firstRow: ranges[0][0],
    lastRow: ranges.at(-1)![1],
  }
}

export type { Excerpt, ExcerptOptions, Fragment, LocatedItem }
export { ExcerptError, excerpt }
