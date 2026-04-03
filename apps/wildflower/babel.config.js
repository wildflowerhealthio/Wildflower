module.exports = (api) => {
  api.cache(true)
  return {
    exclude: ['**/browser-sniffer/sniffer.js'],
    presets: [
      [
        'babel-preset-expo',
        {
          unstable_transformImportMeta: true,
        },
      ],
    ],
    plugins: ['babel-plugin-transform-vite-meta-env', '@babel/plugin-syntax-import-attributes'],
  }
}
