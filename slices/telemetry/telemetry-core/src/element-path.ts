/**
 * Reduces the element strings the Sentry SDK writes (its `htmlTreeAsString`)
 * to their tag names, so no text a page renders leaves the browser.
 *
 * @remarks
 * The SDK writes the element a visitor clicked, or the page painted or
 * shifted, as its ancestors and itself joined by ` > `, each as its tag name
 * followed by its `#id`, its `.classes` and the values of its `aria-label`,
 * `type`, `name`, `title` and `alt` attributes: `button#open.tab[aria-label="Open Jane Doe's results"]`.
 * Ids and attribute values can name a patient; classes can carry an id too.
 */

/** What an element string that does not parse is replaced with. */
const UNREADABLE_ELEMENT = '{element}'

/**
 * One element of an element string: the tag name (captured), then any `#id`
 * and `.class` parts, then any `[name="value"]` parts. Unambiguous, so a
 * string that does not match fails fast.
 */
const ELEMENT = String.raw`([a-z][a-z0-9-]*)(?:[#.][^\s\[#.]*)*(?:\[[\w-]+="[^"]*"\])*`

/** A whole element string: elements joined by ` > `. */
const ELEMENT_STRING = new RegExp(String.raw`^${ELEMENT}(?: > ${ELEMENT})*$`)

/** One element of an element string, for reading its tag names in turn. */
const ELEMENT_IN_STRING = new RegExp(String.raw`(?:^| > )${ELEMENT}`, 'g')

/**
 * `elementString` reduced to its tag names, joined by ` > ` as the SDK joins
 * the elements (`body > div > button`), or {@link UNREADABLE_ELEMENT} when it
 * does not read as an element string.
 *
 * @remarks
 * Idempotent: a tag-name path reduces to itself. An attribute value with a
 * double quote in it can make the string fail to parse, which drops all of
 * it rather than risk keeping part of the value.
 */
const elementPath = (elementString: string): string =>
  ELEMENT_STRING.test(elementString)
    ? Array.from(elementString.matchAll(ELEMENT_IN_STRING), ([, tagName]) => tagName).join(' > ')
    : UNREADABLE_ELEMENT

export { elementPath, UNREADABLE_ELEMENT }
