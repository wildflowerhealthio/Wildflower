import fs from 'node:fs'
import inspector from 'node:inspector/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Effect } from 'effect'
import { describe, test } from 'vite-plus/test'

import { samplePatient } from '../integration-tests/fixtures.ts'
import { wireServer } from '../integration-tests/server-helpers.ts'

const SEED_COUNT = Number(process.env['PROFILE_N'] ?? 100)
const SEARCH_ITERATIONS = Number(process.env['PROFILE_M'] ?? 5)
const PAGE_SIZE = Number(process.env['PROFILE_PAGE_SIZE'] ?? 10)

// `NODE_OPTIONS='--cpu-prof'` doesn't propagate to Vitest's pool workers, so
// the in-process inspector is the only way to capture the workload from
// inside the test. Output lands next to the legacy CLI-side profiles for
// convenience.
const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.profiles')

describe('Patient search profile workload', () => {
  test(`seed ${SEED_COUNT} patients, run SearchByGet ×${SEARCH_ITERATIONS} (page ${PAGE_SIZE})`, async () => {
    fs.mkdirSync(PROFILE_DIR, { recursive: true })

    const wired = await wireServer()
    const session = new inspector.Session()
    session.connect()
    await session.post('Profiler.enable')
    await session.post('Profiler.start')

    try {
      await Effect.runPromise(
        Effect.all(
          Array.from({ length: SEED_COUNT }, (_, i) =>
            wired.resources.Patient.Create({
              payload: samplePatient(`p${String(i).padStart(5, '0')}`),
            })
          )
        )
      )

      // Sequential awaits intentional: we want one search at a time so the
      // CPU profile reflects steady-state cost rather than concurrent fibers.
      for (let i = 0; i < SEARCH_ITERATIONS; i += 1) {
        const start = performance.now()
        // oxlint-disable-next-line no-await-in-loop
        const result = await Effect.runPromise(
          wired.resources.Patient.SearchByGet({ urlParams: { _count: PAGE_SIZE } })
        )
        const ms = performance.now() - start
        // oxlint-disable-next-line no-console
        console.log(
          `[profile] iter=${i + 1}/${SEARCH_ITERATIONS} entries=${result.entry.length} total=${result.total} elapsed=${ms.toFixed(0)}ms`
        )
      }
    } finally {
      const stopResult = await session.post('Profiler.stop')
      await session.post('Profiler.disable')
      session.disconnect()
      const outPath = path.join(
        PROFILE_DIR,
        `worker-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`
      )
      fs.writeFileSync(outPath, JSON.stringify(stopResult.profile))
      // oxlint-disable-next-line no-console
      console.log(`[profile] worker cpuprofile written to ${outPath}`)
      await wired.dispose()
    }
  })
})
