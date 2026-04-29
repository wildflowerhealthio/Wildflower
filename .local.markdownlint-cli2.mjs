import relativeLinksRule from 'markdownlint-rule-relative-links'
import baseConfig from './.markdownlint-cli2.mjs'

const config = {
  ...baseConfig,
  outputFormatters: [['markdownlint-cli2-formatter-pretty', { appendLink: true }]],
  customRules: [relativeLinksRule],
}

export default config
