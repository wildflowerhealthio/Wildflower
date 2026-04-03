// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config')
const { addLiveStoreDevtoolsMiddleware } = require('@livestore/devtools-expo')

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname)

addLiveStoreDevtoolsMiddleware(config, { schemaPath: './livestore/schema.ts' })

config.resolver.assetExts.push('txt')

// console.log(config)
module.exports = config
