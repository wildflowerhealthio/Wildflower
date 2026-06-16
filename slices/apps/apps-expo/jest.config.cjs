module.exports = {
  preset: 'jest-expo',
  // This package is now read-only reference scaffolding (its host-binding
  // tunnel flow is a no-op until rewired to the Rust tunnel); its behavioral
  // tests were dropped with the TS server stack. Keep `vp run jest` green
  // without a placeholder test.
  passWithNoTests: true,
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|msgpackr|msgpackr-extract))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
}
