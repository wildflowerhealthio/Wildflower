import { Effect } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { samplePatient } from './fixtures.ts'
import { wireServerScoped } from './server-helpers.ts'

interface BundleLink {
  readonly relation: string
  readonly url: string
}

const findLink = (link: ReadonlyArray<BundleLink>, relation: string): BundleLink | undefined =>
  link.find((l) => l.relation === relation)

const decodePageTokenFromUrl = (url: string): string | null =>
  new URL(url).searchParams.get('_pageToken')

describe('GET /Patient pagination', () => {
  test('25 patients, _count=10 — follow next link 3 times; previous appears on page 2', () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Arrange
          const wired = yield* wireServerScoped
          yield* Effect.all(
            Array.from({ length: 25 }, (_, i) =>
              wired.resources.Patient.Create({
                payload: samplePatient(`p${String(i).padStart(3, '0')}`),
              })
            )
          )

          // Act / Assert — page 1
          const page1 = yield* wired.resources.Patient.SearchByGet({
            urlParams: { _count: 10 },
          })
          expect(page1.total).toBe(25)
          expect(page1.entry).toHaveLength(10)
          expect(findLink(page1.link, 'previous')).toBeUndefined()
          const next1Token = (() => {
            const link = findLink(page1.link, 'next')
            expect(link).toBeDefined()
            return decodePageTokenFromUrl(link!.url)!
          })()

          // Page 2
          const page2 = yield* wired.resources.Patient.SearchByGet({
            urlParams: { _count: 10, _pageToken: next1Token },
          })
          expect(page2.entry).toHaveLength(10)
          expect(findLink(page2.link, 'previous')).toBeDefined()
          const next2Token = (() => {
            const link = findLink(page2.link, 'next')
            expect(link).toBeDefined()
            return decodePageTokenFromUrl(link!.url)!
          })()

          // Page 3 (final — 5 remaining)
          const page3 = yield* wired.resources.Patient.SearchByGet({
            urlParams: { _count: 10, _pageToken: next2Token },
          })
          expect(page3.entry).toHaveLength(5)
          expect(findLink(page3.link, 'next')).toBeUndefined()
          expect(findLink(page3.link, 'previous')).toBeDefined()

          const collected = [...page1.entry, ...page2.entry, ...page3.entry]
            .map((e) => e.resource?.id)
            .filter((id): id is string => id !== undefined)
          expect(new Set(collected).size).toBe(25)
        })
      )
    ))
})
