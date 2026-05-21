// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { addLiveStoreDevtoolsMiddleware } = require('@livestore/devtools-expo')
const { DuplicateDependencies } = require('@rnx-kit/metro-plugin-duplicates-checker')
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

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'crypto') {
    // when importing crypto, resolve to react-native-quick-crypto
    return context.resolveRequest(context, 'react-native-quick-crypto', platform)
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
config.resolver.sourceExts = ['jsx', 'js', 'ts', 'tsx', 'cjs', 'json', 'module.css', 'css']

// Resolve workspace packages through their "source" export condition so edits
// to their .ts sources hot-reload without running `vp pack` first.
config.resolver.unstable_conditionNames = [
  'source',
  ...(config.resolver.unstable_conditionNames ?? ['react-native', 'require', 'import', 'browser']),
]

module.exports = config
