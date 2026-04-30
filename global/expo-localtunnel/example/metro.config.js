const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const config = getDefaultConfig(__dirname)

// Self-alias so `import 'expo-localtunnel'` from this example resolves to the parent package.
config.resolver.extraNodeModules = {
  'expo-localtunnel': path.resolve(__dirname, '..'),
}

module.exports = config
