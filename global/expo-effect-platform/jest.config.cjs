module.exports = {
  preset: 'jest-expo',
  // Only `*.test.ts` files are test suites. Sibling helper modules (e.g.
  // `__tests__/file-system/mock-expo-file-system.ts`) are imported by tests
  // but contain no `test()` blocks — jest's default `**/__tests__/**/*.ts`
  // glob would pick them up and fail "Test suite must contain at least
  // one test."
  testMatch: ['**/__tests__/**/*.test.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'],
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|msgpackr|msgpackr-extract))',
    '/node_modules/react-native-reanimated/plugin/',
  ],
}
