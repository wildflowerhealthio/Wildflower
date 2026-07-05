import tsdoc from 'eslint-plugin-tsdoc'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/dist-html/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/tapes/**',
      '**/*.gen.*',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: { tsdoc },
    rules: {
      'tsdoc/syntax': 'warn',
    },
  },
]
