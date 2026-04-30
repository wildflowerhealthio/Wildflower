const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

// Self-alias so `import 'expo-effect-platform'` from this example resolves to the parent package.
config.resolver.extraNodeModules = {
  'expo-effect-platform': path.resolve(__dirname, '..'),
}

module.exports = config
