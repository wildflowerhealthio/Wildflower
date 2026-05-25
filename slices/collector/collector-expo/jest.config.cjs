module.exports = {
  preset: 'jest-expo',
  // passWithNoTests until the replacement collector-expo screen ships; see migration guide.
  passWithNoTests: true,
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|msgpackr|msgpackr-extract))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
}
