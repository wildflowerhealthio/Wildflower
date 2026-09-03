import { type DdinterFile, type DdinterSource, pairKey } from './ddinter.ts'
import { parseSeverity, type Severity, severityRank, severityToCode } from './severity.ts'

/** One row of a DDInter download CSV, as the converter reads it. */
interface DdinterCsvRow {
  readonly idA: string
  readonly nameA: string
  readonly idB: string
  readonly nameB: string
  readonly severity: Severity
}

/** The header names DDInter's download CSVs use, in the order the converter wants them. */
const ddinterCsvColumns = ['DDInterID_A', 'Drug_A', 'DDInterID_B', 'Drug_B', 'Level'] as const

/**
 * Split CSV text into rows of fields. Handles RFC 4180 quoting (quoted fields
 * may contain commas, newlines and doubled quotes) and either line ending;
 * a trailing newline does not produce an empty row.
 */
const parseCsv = (text: string): readonly (readonly string[])[] => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  // Whether the current record has consumed any character — so a quoted empty
  // field at the end of the text still yields its row, while bare empty text
  // (or a trailing newline) yields none.
  let pending = false
  let i = 0
  while (i < text.length) {
    const char = text[i]
    pending = true
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      pending = false
    } else {
      field += char
    }
    i += 1
  }
  if (pending) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Parse one DDInter download CSV (`DDInterID_A, Drug_A, DDInterID_B, Drug_B,
 * Level`) into rows. Columns are located by header name, so extra or
 * reordered columns are tolerated; a missing column or an unrecognised `Level`
 * throws — the data is expected to be exactly DDInter's, and anything else
 * should stop the conversion rather than be silently dropped.
 */
const parseDdinterCsv = (text: string): readonly DdinterCsvRow[] => {
  const [header, ...lines] = parseCsv(text)
  if (header === undefined) return []
  const columns = ddinterCsvColumns.map((name) => {
    const index = header.findIndex((cell) => cell.trim() === name)
    if (index === -1) throw new Error(`DDInter CSV is missing the "${name}" column`)
    return index
  })
  return lines.flatMap((cells, lineIndex) => {
    if (cells.every((cell) => cell.trim() === '')) return []
    const cell = (column: number): string => (cells[columns[column] ?? -1] ?? '').trim()
    const line = lineIndex + 2
    const level = cell(4)
    const severity = parseSeverity(level)
    if (severity === null)
      throw new Error(`DDInter CSV line ${line}: unrecognised Level "${level}"`)
    const row: DdinterCsvRow = {
      idA: cell(0),
      nameA: cell(1),
      idB: cell(2),
      nameB: cell(3),
      severity,
    }
    if (!row.idA || !row.nameA || !row.idB || !row.nameB) {
      throw new Error(`DDInter CSV line ${line}: empty drug id or name`)
    }
    return [row]
  })
}

/**
 * Build the compact {@link DdinterFile} from every row of every download CSV.
 *
 * @param rows - Rows from all the per-ATC CSVs, concatenated (any order)
 * @param source - Attribution to embed in the file
 * @returns A file that satisfies the {@link DdinterFile} invariants
 *
 * @remarks
 * Drugs are keyed by DDInter id and the table is sorted by id so the output
 * is stable regardless of file order (the first name seen for an id is kept).
 * The same pair appears in several ATC files; it is emitted once, and if the
 * files disagree on the level the more severe one wins. Self-pairs are dropped.
 */
const buildDdinterFile = (rows: readonly DdinterCsvRow[], source: DdinterSource): DdinterFile => {
  const names = new Map<string, string>()
  for (const { idA, nameA, idB, nameB } of rows) {
    if (!names.has(idA)) names.set(idA, nameA)
    if (!names.has(idB)) names.set(idB, nameB)
  }
  const ids = [...names.keys()].toSorted((a, b) => a.localeCompare(b))
  const indexOf = new Map(ids.map((id, index) => [id, index]))

  // One entry per unordered pair; a later row only replaces a more-severe one.
  const pairs = new Map<string, { readonly a: number; readonly b: number; severity: Severity }>()
  for (const { idA, idB, severity } of rows) {
    const a = indexOf.get(idA)
    const b = indexOf.get(idB)
    if (a === undefined || b === undefined || a === b) continue
    const key = pairKey(a, b)
    const existing = pairs.get(key)
    if (existing === undefined) {
      pairs.set(key, { a: Math.min(a, b), b: Math.max(a, b), severity })
    } else if (severityRank[severity] < severityRank[existing.severity]) {
      existing.severity = severity
    }
  }

  return {
    source,
    drugs: ids.map((id) => [id, names.get(id) ?? id] as const),
    pairs: [...pairs.values()]
      .map(({ a, b, severity }) => [a, b, severityToCode(severity)] as const)
      .toSorted(([a1, b1], [a2, b2]) => a1 - a2 || b1 - b2),
  }
}

export { buildDdinterFile, type DdinterCsvRow, ddinterCsvColumns, parseCsv, parseDdinterCsv }
