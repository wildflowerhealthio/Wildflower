// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { addLiveStoreDevtoolsMiddleware } = require('@livestore/devtools-expo')
const { DuplicateDependencies } = require('@rnx-kit/metro-plugin-duplicates-checker')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(__dirname, '../..')
const embeddableHtmlBuiltPath = path.resolve(
  workspaceRoot,
  'apps/wildflower-react/dist-embedded/html.js'
)

/**
 * Reports any package that ends up bundled at two paths.
 * @param {import('expo/metro-config').MetroConfig} config
 * @returns {import('expo/metro-config').MetroConfig}
 */
const withDuplicatesDiagnostic = (config) => {
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
  return config
}

/**
 * Custom resolver: crypto -> react-native-quick-crypto; wildflower-react/embeddable-html -> built bundle (or stub).
 * @param {import('expo/metro-config').MetroConfig} config
 * @param {{ embeddableHtmlBuiltPath: string }} opts
 * @returns {import('expo/metro-config').MetroConfig}
 */
const withWildflowerResolveRequest = (config, opts) => {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (moduleName === 'crypto') {
      // when importing crypto, resolve to react-native-quick-crypto
      return context.resolveRequest(context, 'react-native-quick-crypto', platform)
    }
    // When `wildflower-react/embeddable-html` resolves under the `source`
    // condition it lands on the stub at `apps/wildflower-react/src/embeddable-html-stub.ts`,
    // which has no way to read the built bundle at runtime on-device. If
    // a fresh `dist-embedded/html.js` exists, prefer it directly so the
    // Expo app sees the real bundled HTML; otherwise fall through to the
    // stub (which renders the "not built" placeholder).
    if (moduleName === 'wildflower-react/embeddable-html') {
      if (fs.existsSync(opts.embeddableHtmlBuiltPath)) {
        return { type: 'sourceFile', filePath: opts.embeddableHtmlBuiltPath }
      }
      // oxlint-disable-next-line no-console
      console.error(
        `No compiled react app at ${opts.embeddableHtmlBuiltPath}, please run "vp build:embedded" to generate it.`
      )
    }
    // otherwise chain to the standard Metro resolver.
    return context.resolveRequest(context, moduleName, platform)
  }
  return config
}

/** @type {import('expo/metro-config').MetroConfig} */
let config = getDefaultConfig(projectRoot)
config.resolver.assetExts.push('txt')

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

// Monorepo setup — always include the workspace root so Metro can
// resolve hoisted node_modules and watch workspace package sources.
// 1. Watch all files within the monorepo
config.watchFolders = [workspaceRoot]
// 2. Let Metro know where to resolve packages, and in what order
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
]
// 3. Force Metro to resolve (sub)dependencies only from the `nodeModulesPaths`
config.resolver.disableHierarchicalLookup = true

config = withDuplicatesDiagnostic(config)
config = withWildflowerResolveRequest(config, { embeddableHtmlBuiltPath })

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
