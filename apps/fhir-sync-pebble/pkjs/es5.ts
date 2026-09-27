/**
 * How the PebbleKit JS bundle gets to ES5, the language level the phone's
 * runtime runs. Rolldown bundles without lowering anything, the TypeScript
 * compiler lowers the bundle to ES5 ({@link lowerToEs5}), and acorn proves the
 * result parses as ES5 and reads none of the ES2015 globals a helper might
 * reach for. That covers the syntax; {@link checkEs5Library} covers the
 * library, type-checking the bundled sources against ES5's so no ES2015 method
 * (say `Array.prototype.includes`) ships.
 *
 * @remarks
 * TypeScript 5 is the lowering tool because nothing else in the workspace emits
 * ES5: rolldown and oxc stop at ES2015, and lower some later syntax through
 * helpers that read `Symbol`. TypeScript 7 drops the ES5 target, so this needs
 * the 5.x the workspace's `overrides` pin.
 *
 * @packageDocumentation
 */

import { dirname, resolve } from 'node:path'

import { parse, tokenizer, tokTypes } from 'acorn'
import ts from 'typescript'

/**
 * `code`, bundled JavaScript of any later level, lowered to ES5. Throws when
 * the lowered code still doesn't parse as ES5, naming where, or reads one of
 * {@link ES2015_GLOBALS}.
 */
const lowerToEs5 = (code: string): string => {
  const lowered = ts.transpileModule(code, {
    fileName: 'index.js',
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      sourceMap: false,
    },
  }).outputText
  parse(lowered, { ecmaVersion: 5, sourceType: 'script' })
  const es2015Globals = es2015GlobalsIn(lowered)
  if (es2015Globals.length > 0) {
    throw new Error(`The ES5 bundle reads ES2015 globals: ${es2015Globals.join(', ')}`)
  }
  return lowered
}

/** Globals an ES5 runtime lacks that a bundler's or compiler's helpers might read. */
const ES2015_GLOBALS: ReadonlySet<string> = new Set([
  'Map',
  'Promise',
  'Proxy',
  'Reflect',
  'Set',
  'Symbol',
  'WeakMap',
  'WeakSet',
])

/**
 * The {@link ES2015_GLOBALS} `code`, ES5, names as a variable rather than a
 * property, in order of appearance. Comments and strings don't count.
 */
const es2015GlobalsIn = (code: string): Array<string> => {
  const found: Array<string> = []
  let previousType: unknown = undefined
  for (const token of tokenizer(code, { ecmaVersion: 5 })) {
    const name = code.slice(token.start, token.end)
    if (token.type === tokTypes.name && previousType !== tokTypes.dot && ES2015_GLOBALS.has(name)) {
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
 * has.
 *
 * @remarks
 * Only the bundled files are checked: a module imported for its types alone is
 * in the program but not the bundle, and it may use what ES5 lacks. So are the
 * program's global diagnostics, which the declaration files such a module
 * brings in raise against ES5's library.
 *
 * @param bundledFiles - Absolute paths of the modules the bundle holds
 */
const checkEs5Library = (tsconfigPath: string, bundledFiles: ReadonlyArray<string>): void => {
  const configFile = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path))
  if (configFile.error !== undefined) {
    throw new Error(formatDiagnostics([configFile.error]))
  }
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(tsconfigPath))
  // tsconfig.json targets ES2015 for the editor and `vp check`, whose
  // TypeScript 7 has no ES5 target; checked as ES5, spreading or iterating
  // anything but an array or string is an error, as it is once lowered.
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: { ...config.options, target: ts.ScriptTarget.ES5 },
  })
  const shipped = new Set(bundledFiles.map((file) => resolve(file)))
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
