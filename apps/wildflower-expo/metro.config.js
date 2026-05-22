// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { addLiveStoreDevtoolsMiddleware } = require('@livestore/devtools-expo')
const { DuplicateDependencies } = require('@rnx-kit/metro-plugin-duplicates-checker')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(__dirname, '../..')
/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(projectRoot)

config.resolver.assetExts.push('txt')

// Monorepo setup — always include the workspace root so Metro can
// resolve hoisted node_modules and watch workspace package sources.
// const workspaceRoot = path.resolve(__dirname, '../..')
// config.watchFolders = [workspaceRoot]

addLiveStoreDevtoolsMiddleware(config, {
  schemaPath: './src/livestore/schema.ts',
  viteConfig: (viteConfig) => {
    viteConfig.server.fs ??= {}
    viteConfig.server.fs.strict = false
    viteConfig.optimizeDeps ??= {}
    viteConfig.optimizeDeps.force = true
    return viteConfig
  },
})

// 1. Watch all files within the monorepo
config.watchFolders = [workspaceRoot]
// 2. Let Metro know where to resolve packages, and in what order
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// 3. Force Metro to resolve (sub)dependencies only from the `nodeModulesPaths`
config.resolver.disableHierarchicalLookup = true

// Diagnostic: report any package that ends up bundled at two paths.
// Why: chasing a runtime "Not a valid effect: {}" — symptom of two Effect copies.
// `throwOnError: false` so we still get a running app to inspect alongside the report.
// oxlint-disable-next-line typescript/no-unsafe-assignment
const checkDuplicates = DuplicateDependencies({ throwOnError: false })
const expoSerializer = config.serializer.customSerializer
config.serializer.customSerializer = (entryPoint, preModules, graph, options) => {
  try {
    checkDuplicates(entryPoint, preModules, graph, options)
  } catch (err) {
    // oxlint-disable-next-line no-console
    console.error('[duplicates-checker]', err)
  }
  return expoSerializer(entryPoint, preModules, graph, options)
}

// When `wildflower-react/embeddable-html` resolves under the `source`
// condition it lands on the stub at `apps/wildflower-react/src/embeddable-html-stub.ts`,
// which has no way to read the built bundle at runtime on-device. If
// a fresh `dist-embedded/html.js` exists, prefer it directly so the
// Expo app sees the real bundled HTML; otherwise fall through to the
// stub (which renders the "not built" placeholder).
const embeddableHtmlBuiltPath = path.resolve(
  workspaceRoot,
  'apps/wildflower-react/dist-embedded/html.js'
)
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'crypto') {
    // when importing crypto, resolve to react-native-quick-crypto
    return context.resolveRequest(context, 'react-native-quick-crypto', platform)
  }
  if (moduleName === 'wildflower-react/embeddable-html' && fs.existsSync(embeddableHtmlBuiltPath)) {
    // Route around the `source`-condition stub when a real build exists.
    return { type: 'sourceFile', filePath: embeddableHtmlBuiltPath }
  }
  // otherwise chain to the standard Metro resolver.
  return context.resolveRequest(context, moduleName, platform)
}

config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: false,
  },
})

config.resolver.sourceExts = ['jsx', 'js', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'module.css', 'css']

// Resolve workspace packages through their "source" export condition so edits
// to their .ts sources hot-reload without running `vp pack` first.
config.resolver.unstable_conditionNames = [
  'source',
  ...(config.resolver.unstable_conditionNames ?? ['react-native', 'require', 'import', 'browser']),
]

module.exports = config
