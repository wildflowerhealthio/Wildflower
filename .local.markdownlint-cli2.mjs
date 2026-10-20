import relativeLinksRule from 'markdownlint-rule-relative-links'
import baseConfig from './.markdownlint-cli2.mjs'

/** A link's fragment the book's `{{#item}}` anchors fill in at build time (`#item-Grant`). */
const BOOK_ITEM_FRAGMENT = /#item-[^"]*" should have a valid fragment identifier/

/**
 * relative-links, letting a link to another chapter's `{{#item}}` anchor
 * through, as `link-fragments` does on the same page (.markdownlint-cli2.mjs).
 */
const relativeLinks = {
  ...relativeLinksRule,
  function: (params, onError) =>
    relativeLinksRule.function(params, (error) => {
      if (!BOOK_ITEM_FRAGMENT.test(error.detail ?? '')) onError(error)
    }),
}

const config = {
  ...baseConfig,
  outputFormatters: [['markdownlint-cli2-formatter-pretty', { appendLink: true }]],
  customRules: [relativeLinks],
}

export default config
