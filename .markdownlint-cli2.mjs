const config = {
  config: {
    default: true,
    'line-length': false,
    'relative-links': {
      root_path: '.',
    },
    'no-trailing-punctuation': {
      punctuation: '.',
    },
    'no-duplicate-heading': {
      siblings_only: true,
    },
    'ol-prefix': {
      style: 'one_or_ordered',
    },
    'first-line-heading': {
      front_matter_title: '^\\s*(name|title)\\s*:',
    },
  },
  globs: ['**/*.md'],
  ignores: ['**/node_modules', '**/dist/**', '**/dist-html/**', '**/vendor/**'],
}

export default config
