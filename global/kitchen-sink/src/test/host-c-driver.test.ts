import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { buildHostCDriver, type HostCDriver } from './host-c-driver.ts'
import { numRunsFor } from './num-runs-for.ts'

// An echo driver in the shape the watchapps' drivers take: one command per
// line in, the same text back with its first byte replaced, out.
const ECHO_DRIVER = `
#include <stdio.h>
#include <string.h>

int main(void) {
  char line[256];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    line[strcspn(line, "\\n")] = '\\0';
    printf("echo:%s\\n", line);
  }
  return 0;
}
`

const OVERFLOWING_DRIVER = `
#include <string.h>

int main(void) {
  char buffer[4];
  char *volatile end = buffer + 4;
  memset(end, 'x', 1);
  return buffer[0];
}
`

let sourceDir: string

beforeAll(() => {
  sourceDir = mkdtempSync(join(tmpdir(), 'host-c-driver-test-'))
})

afterAll(() => {
  rmSync(sourceDir, { recursive: true, force: true })
})

const writeSource = (fileName: string, source: string): string => {
  const path = join(sourceDir, fileName)
  writeFileSync(path, source)
  return path
}

describe('buildHostCDriver', () => {
  let driver: HostCDriver

  beforeAll(() => {
    driver = buildHostCDriver({
      name: 'echo-driver',
      sources: [writeSource('echo-driver.c', ECHO_DRIVER)],
    })
  })

  afterAll(() => {
    driver.dispose()
  })

  it('returns the output line with trailing spaces kept', () => {
    expect(driver.run('a  ')).toBe('echo:a  ')
  })

  it('answers any printable command with its own line', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ -~]{0,100}$/), (command) => {
        expect(driver.run(command)).toBe(`echo:${command}`)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('throws when the sources do not compile', () => {
    expect(() =>
      buildHostCDriver({
        name: 'broken-driver',
        sources: [writeSource('broken-driver.c', 'int main(void) { return missing; }')],
      })
    ).toThrow()
  })

  it('fails a run that writes past a buffer', () => {
    const overflowing = buildHostCDriver({
      name: 'overflowing-driver',
      sources: [writeSource('overflowing-driver.c', OVERFLOWING_DRIVER)],
    })
    try {
      expect(() => overflowing.run('')).toThrow()
    } finally {
      overflowing.dispose()
    }
  })
})
