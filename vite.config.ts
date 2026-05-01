import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite-plus'
export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.interface.test.{ts,tsx}',
      // This is a react native app and the tests are run in jest
      './apps/wildflower/**',
    ],
    server: {
      deps: {
        inline: ['@effect/vitest', '@fast-check/vitest', '@testing-library/react'],
      },
    },
    setupFiles: [
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        './slices/store/store-core/vitest.setupSchemaEqual.ts'
      ),
    ],
  },
  fmt: {
    trailingComma: 'es5',
    tabWidth: 2,
    semi: false,
    singleQuote: true,
    printWidth: 100,
    sortPackageJson: {
      sortScripts: true,
    },
    sortImports: {
      partitionByNewline: true,
      newlinesBetween: false,
    },
    ignorePatterns: [
      '**/tapes/**/*',
      '**/dist/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/test/snapshots/**',
      'slices/apps/vendor-apps/src/generated-*.ts',
    ],
  },
  lint: {
    ignorePatterns: [
      '**/tapes/**/*',
      '**/dist/**',
      '**/dist/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/test/snapshots/**',
      'slices/apps/vendor-apps/src/generated-*.ts',
    ],
    plugins: ['typescript', 'react', 'unicorn', 'import'],
    categories: {
      correctness: 'error',
      suspicious: 'error',
      // pedantic: "warn",
      // perf: "error",
      // style: "error",
      // restriction: "error",
    },
    env: {
      builtin: true,
      es2024: true,
    },
    options: {
      typeAware: true,
      typeCheck: true,
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Explicitly disabled rules
      'import/no-unassigned-import': 'off',
      'import/no-named-export': 'off',
      'unicorn/filename-case': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
      '@typescript-eslint/no-namespace': 'off',
      'react/react-in-jsx-scope': 'off',
      'import/namespace': 'off',

      // Configured rules
      'no-shadow': ['error', { allow: ['fc'] }],
      'import/max-dependencies': ['warn', { max: 15 }],
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'always' }],
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'react/only-export-components': [
        'error',
        {
          allowExportNames: [
            'loader',
            'clientLoader',
            'action',
            'clientAction',
            'ErrorBoundary',
            'HydrateFallback',
            'headers',
            'handle',
            'links',
            'meta',
            'shouldRevalidate',
          ],
        },
      ],

      // Extra rules
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowIIFEs: true, allowExpressions: true },
      ],
      'unicorn/no-array-callback-reference': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'import/default': 'error',
      'import/no-named-as-default': 'warn',
      'import/no-named-as-default-member': 'warn',
      'import/no-duplicates': 'warn',

      // Enable-only rules (warnings — violations not yet fixed)
      'react/no-array-index-key': 'warn',
      'no-await-in-loop': 'warn',
      'no-deprecated': 'warn',
      'no-warning-comments': 'warn',
      'switch-exhaustiveness-check': 'warn',
      'no-void': ['error', { allowAsStatement: true }],
      'react/button-has-type': 'warn',
      'import/group-exports': 'warn',
      'react/jsx-curly-brace-presence': ['error', { propElementValues: 'always' }],
      'react/jsx-filename-extension': ['error', { extensions: ['.jsx', '.tsx'] }],
      'no-console': 'warn',
      'no-ternary': 'warn',
    },
    overrides: [
      {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        rules: {
          'no-var': 'error',
          'no-with': 'off',
          'prefer-const': 'error',
          'prefer-rest-params': 'error',
          'prefer-spread': 'error',
        },
      },
      {
        files: ['**/*.tsx'],
        rules: {
          'no-ternary': 'off',
        },
      },
      {
        files: ['apps/wildflower/**'],
        rules: {
          'no-console': 'off',
          'eslint-plugin-unicorn/require-post-message-target-origin': 'off',
        },
      },
      {
        files: ['apps/wildflower/app/routes/**'],
        rules: {
          'import/no-default-export': 'off',
        },
      },
      {
        files: ['apps/wildflower/android/app/build', 'apps/wildflower/dist/*'],
        rules: {},
      },
      {
        files: ['apps/wildflower/**/metro.config.js'],
        env: {
          node: true,
        },
      },
      {
        files: ['apps/wildflower/**/*.ts', 'apps/wildflower/**/*.tsx', 'apps/wildflower/**/*.d.ts'],
        rules: {
          '@typescript-eslint/array-type': [
            'warn',
            {
              default: 'array',
            },
          ],
          '@typescript-eslint/no-empty-object-type': 'warn',
          '@typescript-eslint/no-wrapper-object-types': 'warn',
          '@typescript-eslint/consistent-type-assertions': [
            'warn',
            {
              assertionStyle: 'as',
              objectLiteralTypeAssertions: 'allow',
            },
          ],
          '@typescript-eslint/no-extra-non-null-assertion': 'warn',
          'no-unused-vars': [
            'warn',
            {
              vars: 'all',
              args: 'none',
              ignoreRestSiblings: true,
              caughtErrors: 'all',
            },
          ],
          'no-useless-constructor': 'warn',
          '@typescript-eslint/no-require-imports': [
            'warn',
            {
              allow: [
                '\\.(aac|aiff|avif|bmp|caf|db|gif|heic|html|jpeg|jpg|json|m4a|m4v|mov|mp3|mp4|mpeg|mpg|otf|pdf|png|psd|svg|ttf|wav|webm|webp|xml|yaml|yml|zip)$',
              ],
            },
          ],
        },
        plugins: ['typescript'],
      },
      {
        files: ['apps/wildflower/**'],
        plugins: ['import', 'react'],
        jsPlugins: ['eslint-plugin-expo'],
        env: {
          builtin: true,
          es2022: true,
          browser: true,
        },
        globals: {
          exports: 'readonly',
          global: 'readonly',
          module: 'readonly',
          require: 'readonly',
          AudioWorkletGlobalScope: 'readonly',
          AudioWorkletProcessor: 'readonly',
          currentFrame: 'readonly',
          currentTime: 'readonly',
          registerProcessor: 'readonly',
          sampleRate: 'readonly',
          WorkletGlobalScope: 'readonly',
          __DEV__: 'readonly',
          ErrorUtils: 'readonly',
          clearImmediate: 'readonly',
          process: 'readonly',
          setImmediate: 'readonly',
          'shared-node-browser': 'writable',
        },
        // ignorePatterns: ['android/app/build', 'dist/*'],
        rules: {
          // Disables
          'no-console': 'off',
          'react/style-prop-object': 'off',
          ///
          'import/namespace': 'error',
          'import/no-named-as-default': 'warn',
          'import/no-named-as-default-member': 'warn',
          'import/no-duplicates': 'warn',
          eqeqeq: ['warn', 'smart'],
          'no-dupe-class-members': 'error',
          'no-dupe-keys': 'error',
          'no-duplicate-case': 'error',
          'no-empty-character-class': 'warn',
          'no-empty-pattern': 'warn',
          'no-extend-native': 'warn',
          'no-extra-bind': 'warn',
          'no-redeclare': 'warn',
          'no-unsafe-negation': 'warn',
          'no-unused-expressions': [
            'warn',
            {
              allowShortCircuit: true,
              enforceForJSX: true,
            },
          ],
          'no-unused-labels': 'warn',
          'no-unused-vars': [
            'warn',
            {
              vars: 'all',
              args: 'none',
              ignoreRestSiblings: true,
              caughtErrors: 'all',
              caughtErrorsIgnorePattern: '^_',
            },
          ],
          'no-with': 'warn',
          'unicode-bom': ['warn', 'never'],
          'use-isnan': 'error',
          'valid-typeof': 'error',
          'import/first': 'warn',
          'no-var': 'error',
          'react/display-name': 'error',
          'react/jsx-key': 'error',
          'react/jsx-no-comment-textnodes': 'error',
          'react/jsx-no-duplicate-props': 'error',
          'react/jsx-no-undef': 'error',
          'react/no-children-prop': 'error',
          'react/no-danger-with-children': 'error',
          'react/no-direct-mutation-state': 'error',
          'react/no-find-dom-node': 'error',
          'react/no-is-mounted': 'error',
          'react/no-render-return-value': 'error',
          'react/no-string-refs': 'error',
          'react/no-unescaped-entities': 'error',
          'react/no-unknown-property': 'warn',
          'react-hooks/rules-of-hooks': 'error',
          'react-hooks/exhaustive-deps': 'warn',
          'react/no-this-in-sfc': 'warn',
          'expo/use-dom-exports': ['error'],
          'expo/no-env-var-destructuring': ['error'],
          'expo/no-dynamic-env-var': ['error'],
        },
      },
    ],
  },
})
