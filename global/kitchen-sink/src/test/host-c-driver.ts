import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A C test driver built with the host compiler: a program that reads one
 * command per stdin line and answers each with one stdout line.
 */
interface HostCDriver {
  /** Runs one driver command and returns its output line, trailing spaces kept. */
  readonly run: (command: string) => string
  /** Deletes the build directory. */
  readonly dispose: () => void
}

/** What {@link buildHostCDriver} compiles. */
interface HostCDriverSources {
  /** Names the temporary build directory, to tell drivers apart in `tmpdir()`. */
  readonly name: string
  /** Absolute paths of the C files to compile together: the driver and the code under test. */
  readonly sources: ReadonlyArray<string>
  /**
   * Absolute paths searched for `#include <...>` headers before the system's,
   * as `-I`: where a test puts host stand-ins for an SDK header (say a fake
   * `pebble.h`) so code that includes it builds on the host. None by default.
   */
  readonly includeDirectories?: ReadonlyArray<string>
}

/**
 * Compiles `sources` with the host `cc` and returns a {@link HostCDriver} over
 * the binary.
 *
 * @remarks
 * For the Pebble watchapps' pure C (code kept free of `pebble.h`), which needs
 * no SDK to test, and for code that includes an SDK header a test stands in for
 * through `includeDirectories`. It compiles as C99, as the SDK compiles apps, under
 * AddressSanitizer and UBSan with recovery off, so an overflow fails the test
 * rather than passing by luck. Call it in `beforeAll` and `dispose` in
 * `afterAll`; a compile error throws, with the compiler's output on stderr.
 */
const buildHostCDriver = ({
  name,
  sources,
  includeDirectories = [],
}: HostCDriverSources): HostCDriver => {
  const buildDir = mkdtempSync(join(tmpdir(), `${name}-`))
  const driverPath = join(buildDir, name)
  try {
    execFileSync(
      'cc',
      [
        '-std=c99',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-g',
        '-fsanitize=address,undefined',
        '-fno-sanitize-recover=all',
        ...includeDirectories.map((directory) => `-I${directory}`),
        '-o',
        driverPath,
        ...sources,
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    rmSync(buildDir, { recursive: true, force: true })
    throw error
  }
  return {
    run: (command) =>
      // stderr is piped so a sanitizer report lands in the thrown error's message.
      execFileSync(driverPath, {
        input: `${command}\n`,
        encoding: 'utf8',
        stdio: 'pipe',
      }).replace(/\n$/, ''),
    dispose: () => rmSync(buildDir, { recursive: true, force: true }),
  }
}

export { buildHostCDriver }
export type { HostCDriver, HostCDriverSources }
