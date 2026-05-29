// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { addLiveStoreDevtoolsMiddleware } = require('@livestore/devtools-expo')
const { DuplicateDependencies } = require('@rnx-kit/metro-plugin-duplicates-checker')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = __dirname
const workspaceRoot = path.resolve(__dirname, '../..')

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
 * Override Metro's module resolution for a fixed set of module specifiers.
 * Each entry maps a module name to a handler that returns a Metro
 * `Resolution`, or `undefined` to fall through to the default resolver.
 * Module names not present in `overrides` are resolved normally.
 * @param {import('expo/metro-config').MetroConfig} config
 * @param {Record<string, (context: import('metro-resolver').ResolutionContext, platform: string | null) => import('metro-resolver').Resolution | undefined>} overrides
 * @returns {import('expo/metro-config').MetroConfig}
 */
const withOverriddenModules = (config, overrides) => {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const handler = overrides[moduleName]
    if (handler !== undefined) {
      const result = handler(context, platform)
      if (result !== undefined) return result
    }
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
config = withOverriddenModules(config, {
  crypto: (context, platform) =>
    context.resolveRequest(context, 'react-native-quick-crypto', platform),
  // When `wildflower-react/embeddable-html` resolves under the `source`
  // condition it lands on the stub at `apps/wildflower-react/src/embeddable-html-stub.ts`,
  // which has no way to read the built bundle at runtime on-device. If
  // a fresh `dist-embedded/html.js` exists, prefer it directly so the
  // Expo app sees the real bundled HTML; otherwise fall through to the
  // stub (which renders the "not built" placeholder).
  'wildflower-react/embeddable-html': () => {
    const embeddableHtmlBuiltPath = path.resolve(
      workspaceRoot,
      'apps/wildflower-react/dist-embedded/html.js'
    )
    if (fs.existsSync(embeddableHtmlBuiltPath)) {
      return { type: 'sourceFile', filePath: embeddableHtmlBuiltPath }
    }
    // oxlint-disable-next-line no-console
    console.error(
      `No compiled react app at ${embeddableHtmlBuiltPath}, please run "vp build:embedded" to generate it.`
    )
    return undefined
  },
  'wildflower-react/single-web-html': () => {
    const singleWebHtmlBuiltPath = path.resolve(
      workspaceRoot,
      'apps/wildflower-react/dist-single-web/html.js'
    )
    if (fs.existsSync(singleWebHtmlBuiltPath)) {
      return { type: 'sourceFile', filePath: singleWebHtmlBuiltPath }
    }
    // oxlint-disable-next-line no-console
    console.error(
      `No compiled react app at ${singleWebHtmlBuiltPath}, please run "vp build:single-web" to generate it.`
    )
    return undefined
  },
})

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
