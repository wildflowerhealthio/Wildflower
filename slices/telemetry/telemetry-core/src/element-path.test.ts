import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import { elementPath, UNREADABLE_ELEMENT } from './element-path.ts'

describe('elementPath', () => {
  test.each([
    {
      label: 'ids, classes and attribute values',
      elementString:
        'body > div#root.app > main.Page__main > button#open-123.tab[type="button"][aria-label="Open Jane Doe\'s results"]',
      path: 'body > div > main > button',
    },
    {
      label: 'an attribute value with ` > ` in it',
      elementString: 'div > img[alt="before > after"][title="Jane > Doe"]',
      path: 'div > img',
    },
    { label: 'a single element', elementString: 'input#mrn[name="mrn"]', path: 'input' },
    { label: 'a tag-name path, as it is', elementString: 'body > div > a', path: 'body > div > a' },
  ])('keeps only the tag names of $label', ({ elementString, path }) => {
    expect(elementPath(elementString)).toBe(path)
  })

  test.each([
    { label: 'the SDK’s fallback name', elementString: '<unknown>' },
    { label: 'an attribute value with a double quote in it', elementString: 'a[title="say "hi""]' },
    {
      label: 'a value crafted to read as a further element',
      elementString: 'a[title="x"] > Jane Doe',
    },
    { label: 'free text', elementString: 'Open Jane Doe’s results' },
    { label: 'nothing', elementString: '' },
  ])('replaces $label with a placeholder', ({ elementString }) => {
    expect(elementPath(elementString)).toBe(UNREADABLE_ELEMENT)
  })

  test('property: keeps no attribute value, and reducing again changes nothing', () => {
    const tagName = fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/)
    const attributeValue = fc.string().filter((value) => !value.includes('"'))
    const element = fc
      .tuple(tagName, fc.array(fc.constantFrom('#id', '.class')), fc.array(attributeValue))
      .map(([tag, parts, values]) => ({
        tag,
        text: `${tag}${parts.join('')}${values.map((value) => `[title="${value}"]`).join('')}`,
      }))
    fc.assert(
      fc.property(fc.array(element, { minLength: 1, maxLength: 5 }), (elements) => {
        const path = elementPath(elements.map(({ text }) => text).join(' > '))

        expect(path).toBe(elements.map(({ tag }) => tag).join(' > '))
        expect(elementPath(path)).toBe(path)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
