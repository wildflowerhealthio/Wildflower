module.exports = {
  preset: 'jest-expo',
  // No tests yet — RunSyncModalScreen + its test were removed in the
  // browser-sniffer-expo BridgedWebView migration; the replacement
  // screen and tests land in a follow-up PR. Without this flag the
  // root-level `vp run -r jest` exits 1 on the empty package.
  passWithNoTests: true,
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|msgpackr|msgpackr-extract))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
}
