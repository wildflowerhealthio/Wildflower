import { defineConfig } from 'vite-plus'
export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  // Resolve workspace-package imports against their `source` export
  // condition (TS source) instead of the default-built dist. Each
  // package.json declares both: `{ "exports": { ".": { "source":
  // "./src/index.ts", "default": "./dist/index.js" } } }`. With this set,
  // `vp dev` / `vp build` / per-app builds skip the slice build step and
  // pick up source edits directly. Vitest projects mode loads each
  // per-package vite.config.ts independently, so the same `resolve.conditions`
  // is duplicated there — without it, tests would still pull from `dist`.
  //
  // Vitest runs test modules through Vite's SSR pipeline, which has its
  // own resolver — `ssr.resolve.conditions`. If only `resolve.conditions`
  // is set, the SSR resolver still picks `default` (the built `dist`),
  // turning every newly-added cross-package export into a runtime
  // `is not a function` error until somebody re-runs `vp pack`. Per-
  // package vite configs that test against workspace deps need BOTH —
  // see `slices/apps/apps-core/vite.config.ts` and
  // `slices/shared-structures/shared-structures-core/vite.config.ts`.
  resolve: {
    conditions: ['source'],
  },
  ssr: {
    resolve: { conditions: ['source'] },
  },
  test: {
    // Each Vitest package owns its own vite.config.ts; listing them as
    // projects lets `vp test` from the workspace root honor per-package
    // settings (e.g. `environment: 'jsdom'` in react-tundraish) instead of
    // running everything under a single root config. Expo packages run on
    // Jest and are intentionally absent.
    projects: [
      'apps/wildflower-react/vite.config.ts',
      'global/effect-messaging/effect-messaging-core/vite.config.ts',
      'global/effect-messaging/effect-messaging-react/vite.config.ts',
      'global/kitchen-sink/vite.config.ts',
      'global/react-kitchen-sink/vite.config.ts',
      'global/react-tundraish/vite.config.ts',
      'slices/**/vite.config.ts',
      '!slices/apps/vendor-apps/vendor/**',
      '!slices/telemetry/telemetry-react-native/**',
      '!**/node_modules/**',
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
      '.claude/**/*',
      '**/tapes/**/*',
      '**/dist/**',
      '**/dist-html/**',
      '**/dist-embedded/**',
      '**/dist-web/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/test/snapshots/**',
      'slices/apps/vendor-apps/src/generated-*.ts',
      '**/*.generated.ts',
      // Build-step bundle output committed for cross-language consumers
      // (e.g. browser-sniffer-tauri's `embedded/tauri-bootstrap.js`, which the
      // Rust slice `include_str!`s at compile time). Owned by esbuild's emit;
      // re-formatting would diverge the bytes from what `vp run generate-*`
      // produces and break staleness checks.
      '**/embedded/**',
      // Effect schemas generated from a service's OpenAPI spec
      // (`openapi-to-effect`); gitignored, reference-only.
      '**/http-api-definition/generated/**',
      // Rust manifests are owned by the Rust toolchain (`cargo fmt` formats
      // `.rs` only; Cargo.toml layout is hand-maintained). oxfmt's TOML rules
      // disagree with how they're written (e.g. collapsing multi-line feature
      // arrays), which would otherwise fail `vp check` — so skip all TOML.
      '**/*.toml',
      // Committed OpenAPI snapshot emitted by the Rust server
      // (`serde_json::to_string_pretty`, written by the `UPDATE_OPENAPI=1`
      // snapshot test). That test asserts byte-exact equality, but oxfmt would
      // collapse its short arrays onto one line and break the test on the next
      // `vp fmt` — so leave its formatting to the serde_json emitter.
      '**/openapi/*.openapi.json',
    ],
  },
  lint: {
    ignorePatterns: [
      '.claude/**/*',
      '**/tapes/**/*',
      '**/dist/**',
      '**/dist-html/**',
      '**/dist-embedded/**',
      '**/dist-web/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/test/snapshots/**',
      'slices/apps/vendor-apps/src/generated-*.ts',
      '**/*.generated.ts',
      // Build-step bundle output committed for cross-language consumers
      // (e.g. browser-sniffer-tauri's `embedded/tauri-bootstrap.js`, which
      // the Rust slice `include_str!`s at compile time). See the fmt
      // ignorePatterns above for the same rationale.
      '**/embedded/**',
      // Effect schemas generated from a service's OpenAPI spec
      // (`openapi-to-effect`); gitignored, reference-only.
      '**/http-api-definition/generated/**',
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
      'eslint/no-underscore-dangle': ['error', { allow: ['_tag', '_count', '_pageToken'] }],
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
      'unicorn/no-array-callback-reference': 'off',
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
      'no-nested-ternary': 'warn',
    },
    overrides: [
      {
        files: ['**/src/routes/**/*.tsx'],
        rules: {
          'react/only-export-components': 'off',
        },
      },
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
