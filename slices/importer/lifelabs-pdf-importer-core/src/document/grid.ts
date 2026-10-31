import type * as Group from '../entities/group.ts'
import type * as Section from '../entities/section.ts'
import type * as TestTableRow from '../entities/test-table-row.ts'
import * as Column from './column.ts'
import * as Table from './table.ts'

/**
 * The results grid, accumulated one page's lines at a time into a small piece
 * of mutable state, then frozen into the report's sections.
 *
 * @remarks
 * {@link create} opens an empty grid; {@link read} feeds it one page's body
 * lines — a line's kind is decided from its leftmost cell's column band
 * (section · group · row · licence · comment); {@link freeze} reads the
 * accumulated sections out as immutable {@link Section.Type}s. The `State` is
 * opaque: hold it, pass it back to `read`/`freeze`, don't reach inside.
 *
 * A section heading repeated verbatim continues the open section (a page break
 * re-prints it) so the open row stays open and a comment carried over the
 * break still lands on it; a lab license, once printed, stays in force until
 * another replaces it.
 *
 * @packageDocumentation
 */

interface RowBuilder {
  name: string
  flag: string
  result: string
  referenceRange: string
  unit: string
  labLicence: string
  readonly comments: string[]
}

interface GroupBuilder {
  readonly name: string
  readonly rows: RowBuilder[]
}

interface SectionBuilder {
  readonly name: string
  readonly comments: string[]
  readonly groups: GroupBuilder[]
}

/**
 * An in-progress grid. Opaque — make one with {@link create}, feed it to
 * {@link read}, read it out with {@link freeze}.
 */
interface State {
  readonly sections: SectionBuilder[]
  section: SectionBuilder | undefined
  group: GroupBuilder | undefined
  row: RowBuilder | undefined
  licence: string
}

/** An empty grid, before any page's lines are read. */
const create = (): State => ({
  sections: [],
  section: undefined,
  group: undefined,
  row: undefined,
  licence: '',
})

/**
 * Open a section. The same name as the open section (the heading a page break
 * repeats) continues it — the open row stays open so a comment carried over
 * the break still lands on it.
 */
const openSection = (state: State, name: string): void => {
  if (state.section?.name === name) return
  state.section = { name, comments: [], groups: [] }
  state.sections.push(state.section)
  state.group = undefined
  state.row = undefined
}

const currentSection = (state: State): SectionBuilder => {
  if (state.section === undefined) openSection(state, '')
  if (state.section === undefined) throw new Error('unreachable: openSection sets section')
  return state.section
}

const openGroup = (state: State, name: string, licence: string): void => {
  if (licence !== '') state.licence = licence
  const group: GroupBuilder = { name, rows: [] }
  currentSection(state).groups.push(group)
  state.group = group
  state.row = undefined
}

const currentGroup = (state: State): GroupBuilder => {
  if (state.group === undefined) {
    const group: GroupBuilder = { name: '', rows: [] }
    currentSection(state).groups.push(group)
    state.group = group
  }
  return state.group
}

const openRow = (state: State, cells: readonly Table.Cell[]): void => {
  const parts: Record<'name' | 'flag' | 'result' | 'range' | 'unit' | 'licence', string[]> = {
    name: [],
    flag: [],
    result: [],
    range: [],
    unit: [],
    licence: [],
  }
  cells.forEach((cell, index) => {
    // The leftmost cell is the name whatever its exact x; the rest classify.
    const column = index === 0 ? 'name' : Column.fromCell(cell)
    if (column === 'section' || column === 'group') parts.name.push(cell.text)
    else parts[column].push(cell.text)
  })
  if (parts.licence.length > 0) state.licence = parts.licence.join(' ')
  const row: RowBuilder = {
    name: parts.name.join(' '),
    flag: parts.flag.join(' '),
    result: parts.result.join(' '),
    referenceRange: parts.range.join(' '),
    unit: parts.unit.join(' '),
    labLicence: state.licence,
    comments: [],
  }
  currentGroup(state).rows.push(row)
  state.row = row
}

const comment = (state: State, text: string): void => {
  if (state.row !== undefined) state.row.comments.push(text)
  else currentSection(state).comments.push(text)
}

/** Feed one page's grid lines into the grid. */
const read = (state: State, body: readonly Table.Line[]): void => {
  for (const line of body) {
    const first = line.cells[0]
    if (first === undefined) continue
    switch (Column.fromCell(first)) {
      case 'section':
        openSection(
          state,
          Table.lineText({
            y: line.y,
            cells: line.cells.filter((c) => Column.fromCell(c) !== 'licence'),
          })
        )
        for (const cell of line.cells)
          if (Column.fromCell(cell) === 'licence') state.licence = cell.text
        break
      case 'group': {
        const named = line.cells.filter((cell) => Column.fromCell(cell) !== 'licence')
        const licence = line.cells.filter((cell) => Column.fromCell(cell) === 'licence')
        openGroup(
          state,
          named.map((cell) => cell.text).join(' '),
          licence.map((c) => c.text).join(' ')
        )
        break
      }
      case 'name':
        openRow(state, line.cells)
        break
      case 'licence':
        state.licence = Table.lineText(line)
        break
      case 'flag':
      case 'result':
      case 'range':
      case 'unit':
        // A line with no name is a comment under the open row (or, before any
        // row, under the section) — whatever inner columns its tokens land in.
        comment(state, Table.lineText(line))
        break
    }
  }
}

const freezeRow = (row: RowBuilder): TestTableRow.Type => ({
  name: row.name,
  flag: row.flag,
  result: row.result,
  referenceRange: row.referenceRange,
  unit: row.unit,
  labLicence: row.labLicence,
  comments: [...row.comments],
})

const freezeGroup = (group: GroupBuilder): Group.Type => ({
  name: group.name,
  rows: group.rows.map(freezeRow),
})

const freezeSection = (section: SectionBuilder): Section.Type => ({
  name: section.name,
  comments: [...section.comments],
  groups: section.groups.map(freezeGroup),
})

/** Read the accumulated grid out as the report's immutable sections. */
const freeze = (state: State): readonly Section.Type[] => state.sections.map(freezeSection)

export { create, freeze, read }
export type { State }
