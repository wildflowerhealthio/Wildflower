/**
 * How the PebbleKit JS bundle gets to ES5, the language level the phone's
 * runtime runs. Rolldown bundles without lowering anything, the TypeScript
 * compiler lowers the bundle to ES5 ({@link lowerToEs5}), and acorn proves the
 * result parses as ES5 and reads none of the later globals a helper might reach
 * for ({@link POST_ES5_GLOBALS}: `Symbol`, `Map`, `Promise`, `globalThis` and
 * a few more). That covers the syntax; {@link checkEs5Library} covers the
 * library, type-checking every bundled source against ES5's library so no
 * later method (say `Array.prototype.includes`) ships.
 *
 * @remarks
 * TypeScript 5 is the lowering tool because nothing else in the workspace emits
 * ES5: rolldown and oxc stop at ES2015, and lower some later syntax through
 * helpers that read `Symbol`. TypeScript 7 drops the ES5 target, so this
 * imports TypeScript 5 under the catalog alias `typescript-es5`.
 *
 * @packageDocumentation
 */

import { dirname, resolve } from 'node:path'

import { parse, tokenizer, tokTypes } from 'acorn'
import ts from 'typescript-es5'

/**
 * `code`, bundled JavaScript of any later level, lowered to ES5 without its
 * comments. Throws when
 * the lowered code still doesn't parse as ES5, naming where, or reads one of
 * {@link POST_ES5_GLOBALS}.
 */
const lowerToEs5 = (code: string): string => {
  const lowered = ts.transpileModule(code, {
    fileName: 'index.js',
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      sourceMap: false,
      // The sources' TSDoc is most of the bundle's size, and the phone never
      // reads it.
      removeComments: true,
    },
  }).outputText
  parse(lowered, { ecmaVersion: 5, sourceType: 'script' })
  const postEs5Globals = postEs5GlobalsIn(lowered)
  if (postEs5Globals.length > 0) {
    throw new Error(`The ES5 bundle reads globals ES5 lacks: ${postEs5Globals.join(', ')}`)
  }
  return lowered
}

/** Globals an ES5 runtime lacks that a bundler's or compiler's helpers might read. */
const POST_ES5_GLOBALS: ReadonlySet<string> = new Set([
  'Map',
  'Promise',
  'Proxy',
  'Reflect',
  'Set',
  'Symbol',
  'WeakMap',
  'globalThis',
  'WeakSet',
])

/**
 * The {@link POST_ES5_GLOBALS} `code`, ES5, names as a variable rather than a
 * property, in order of appearance. Comments and strings don't count.
 */
const postEs5GlobalsIn = (code: string): Array<string> => {
  const found: Array<string> = []
  let previousType: unknown = undefined
  for (const token of tokenizer(code, { ecmaVersion: 5 })) {
    const name = code.slice(token.start, token.end)
    if (
      token.type === tokTypes.name &&
      previousType !== tokTypes.dot &&
      POST_ES5_GLOBALS.has(name)
    ) {
      found.push(name)
    }
    previousType = token.type
  }
  return found
}

/**
 * Type-checks the project `tsconfigPath` names, which sets `lib` to ES5, and
 * throws with the diagnostics in `bundledFiles` when there are any — the
 * sources that ship, workspace packages included, use only what an ES5 runtime
 * has. Also throws when a bundled module isn't in that program at all, so none
 * ships unchecked.
 *
 * @remarks
 * Only the bundled files' diagnostics count, plus the compiler options': a
 * module imported for its types alone is in the program but not the bundle,
 * and it may use what ES5 lacks.
 *
 * @param bundledFiles - The ids of the modules the bundle holds: absolute
 *   paths, or `\0`-prefixed ids for the bundler's own virtual modules, which
 *   aren't checked
 */
const checkEs5Library = (tsconfigPath: string, bundledFiles: ReadonlyArray<string>): void => {
  const configFile = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path))
  if (configFile.error !== undefined) {
    throw new Error(formatDiagnostics([configFile.error]))
  }
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(tsconfigPath))
  // The tsconfig targets ES2015 for the editor and `vp check`, whose
  // TypeScript 7 has no ES5 target; checked as ES5, spreading or iterating
  // anything but an array or string is an error, as it is once lowered.
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, target: ts.ScriptTarget.ES5 },
  })
  const shipped = new Set(
    bundledFiles.filter((file) => !file.startsWith('\0')).map((file) => resolve(file))
  )
  const checked = new Set(program.getSourceFiles().map(({ fileName }) => resolve(fileName)))
  const unchecked = [...shipped].filter((file) => !checked.has(file))
  if (unchecked.length > 0) {
    throw new Error(`Bundled modules outside ${tsconfigPath}'s program: ${unchecked.join(', ')}`)
  }
  const diagnostics = [
    ...config.errors,
    ...program.getOptionsDiagnostics(),
    ...program
      .getSourceFiles()
      .filter((sourceFile) => shipped.has(resolve(sourceFile.fileName)))
      .flatMap((sourceFile) => [
        ...program.getSyntacticDiagnostics(sourceFile),
        ...program.getSemanticDiagnostics(sourceFile),
      ]),
  ]
  if (diagnostics.length > 0) {
    throw new Error(formatDiagnostics(diagnostics))
  }
}

const formatDiagnostics = (diagnostics: ReadonlyArray<ts.Diagnostic>): string =>
  ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getNewLine: () => '\n',
  })

export { checkEs5Library, lowerToEs5 }
