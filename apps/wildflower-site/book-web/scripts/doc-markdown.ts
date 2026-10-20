// A Rust doc comment made into a page's prose (`{{#item}}`, directives.ts):
//
// - Intra-doc links (`[`X`](Self::y)`, `[`X`](crate::a::B)`, `[`X`]`, and
//   `[`X`]` with a `[`X`]: crate::…` definition) go wherever `resolve` says,
//   or become their text (inline code, mostly) when it says nowhere. The
//   definitions' lines are dropped. Links to URLs and anchors stay as written.
// - Headings (`# Errors`, `# Panics`) are demoted: `#` becomes `headingLevel`
//   `#`s, `##` one more, up to six.
// - A code block with no language, or rustdoc's attributes for one
//   (`ignore`, `no_run`), is Rust, and its `# `-hidden lines are dropped,
//   as rustdoc hides them.

interface DocMarkdownOptions {
  /** How many `#`s the doc comment's `#` headings become (1–6). */
  readonly headingLevel: number
  /**
   * Where an intra-doc link's destination (`Self::y`, `crate::a::B`, `B`)
   * goes, or undefined to show the link's text alone.
   */
  readonly resolve: (destination: string) => Promise<string | undefined>
}

/** A link destination rustdoc reads as a path to an item, not a URL. */
const RUST_PATH = /^(?:[a-z]+@)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*(?:\(\)|!)?$/

/** A reference definition's line: `[label]: destination`, optionally titled. */
const DEFINITION =
  /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^>\n]*>|\S+)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?[ \t]*$/

/** rustdoc's attributes on a Rust code block's fence. */
const RUST_FENCE_ATTRIBUTES = new Set([
  'rust',
  'ignore',
  'no_run',
  'should_panic',
  'compile_fail',
  'test_harness',
  'edition2015',
  'edition2018',
  'edition2021',
  'edition2024',
])

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/

const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase()

/** The doc comment cut into prose and fenced blocks, the blocks as they will show. */
const splitFences = (
  markdown: string
): readonly { readonly prose: boolean; readonly text: string }[] => {
  const pieces: { prose: boolean; text: string }[] = []
  const lines = markdown.split('\n')
  let prose: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i])
    if (open === null) {
      prose.push(lines[i])
      continue
    }
    pieces.push({ prose: true, text: prose.join('\n') })
    prose = []
    const marker = open[1]
    const info = open[2].trim()
    const attributes = info.split(/[\s,]+/).filter((a) => a !== '')
    const isRust = attributes.every((a) => RUST_FENCE_ATTRIBUTES.has(a))
    const body: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      if (
        lines[j].trim().startsWith(marker[0].repeat(marker.length)) &&
        lines[j].trim().replace(/[`~]/g, '') === ''
      )
        break
      body.push(lines[j])
    }
    const shown = isRust ? body.filter((line) => !/^\s*#(?: |$)/.test(line)) : body
    pieces.push({
      prose: false,
      text: [`${marker}${isRust ? 'rust' : info}`, ...shown, marker].join('\n'),
    })
    i = j
  }
  pieces.push({ prose: true, text: prose.join('\n') })
  return pieces
}

/** The index just past the `]` matching the `[` at `open`, skipping code spans; -1 if none. */
const closingBracket = (text: string, open: number): number => {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (char === '`') {
      const run = /^`+/.exec(text.slice(i))![0]
      const close = text.indexOf(run, i + run.length)
      if (close < 0) return -1
      i = close + run.length - 1
    } else if (char === '[') depth++
    else if (char === ']' && --depth === 0) return i + 1
  }
  return -1
}

/** The index just past the `)` matching the `(` at `open`; -1 if none. */
const closingParen = (text: string, open: number): number => {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

/** A label with its brackets and backticks gone: `[`Self::y`]` → `Self::y`. */
const labelPath = (label: string): string => label.replace(/^`+|`+$/g, '').trim()

/** `prose` with its links resolved, given the reference definitions. */
const resolveLinks = async (
  prose: string,
  definitions: ReadonlyMap<string, string>,
  resolve: DocMarkdownOptions['resolve']
): Promise<string> => {
  // What each link becomes is resolved after the scan, as `resolve` is async.
  const parts: Promise<string>[] = []
  const link = async (text: string, destination: string): Promise<string> => {
    if (!RUST_PATH.test(destination)) return `[${text}](${destination})`
    const url = await resolve(destination)
    return url === undefined ? text : `[${text}](${url})`
  }
  let at = 0
  let i = 0
  while (i < prose.length) {
    const char = prose[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '`') {
      const run = /^`+/.exec(prose.slice(i))![0]
      const close = prose.indexOf(run, i + run.length)
      i = close < 0 ? i + run.length : close + run.length
      continue
    }
    if (char !== '[') {
      i++
      continue
    }
    const end = closingBracket(prose, i)
    if (end < 0) {
      i++
      continue
    }
    const text = prose.slice(i + 1, end - 1)
    let replaced: { end: number; to: Promise<string> } | undefined
    if (prose[end] === '(') {
      const close = closingParen(prose, end)
      if (close >= 0) {
        const destination = prose.slice(end + 1, close - 1).trim()
        replaced = { end: close, to: link(text, destination) }
      }
    } else if (prose[end] === '[') {
      const close = closingBracket(prose, end)
      const label = close < 0 ? '' : prose.slice(end + 1, close - 1)
      const destination = definitions.get(normalizeLabel(label === '' ? text : label))
      if (close >= 0 && destination !== undefined)
        replaced = { end: close, to: link(text, destination) }
    } else {
      const destination = definitions.get(normalizeLabel(text))
      // A bare `[`X`]` is an intra-doc link; plain `[x]` is only text.
      if (destination !== undefined) replaced = { end, to: link(text, destination) }
      else if (/^`[^`]+`$/.test(text.trim())) replaced = { end, to: link(text, labelPath(text)) }
    }
    if (replaced === undefined) {
      i++
      continue
    }
    parts.push(Promise.resolve(prose.slice(at, i)), replaced.to)
    at = replaced.end
    i = replaced.end
  }
  parts.push(Promise.resolve(prose.slice(at)))
  return (await Promise.all(parts)).join('')
}

/** `prose` with each ATX heading demoted so `#` is `level` deep. */
const demoteHeadings = (prose: string, level: number): string =>
  prose.replace(/^ {0,3}(#{1,6})(?=[ \t]|$)/gm, (_, hashes: string) =>
    '#'.repeat(Math.min(6, level + hashes.length - 1))
  )

/** The doc comment `markdown` as a page's prose (see the top of this file). */
const renderDocMarkdown = async (
  markdown: string,
  options: DocMarkdownOptions
): Promise<string> => {
  const pieces = splitFences(markdown)
  const definitions = new Map<string, string>()
  const withoutDefinitions = pieces.map((piece) => {
    if (!piece.prose) return piece
    const kept = piece.text.split('\n').filter((line) => {
      const definition = DEFINITION.exec(line)
      if (definition === null) return true
      const destination = definition[2].replace(/^<|>$/g, '')
      const label = normalizeLabel(definition[1])
      if (!definitions.has(label)) definitions.set(label, destination)
      return false
    })
    return { prose: true, text: kept.join('\n') }
  })
  const rendered = await Promise.all(
    withoutDefinitions.map(async (piece) =>
      piece.prose
        ? demoteHeadings(
            await resolveLinks(piece.text, definitions, options.resolve),
            options.headingLevel
          )
        : piece.text
    )
  )
  return rendered
    .filter((text, index) => text !== '' || index === 0 || index === rendered.length - 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export type { DocMarkdownOptions }
export { renderDocMarkdown }
