/**
 * Offline replay: run a collector's entities over a static set of responses,
 * with no sniffer, no navigation, and no persistence.
 *
 * @remarks
 * Import the file as a namespace, as with `collector-fundamentals/model`:
 * `import { Recognizer, Replay } from 'collector-fundamentals/replay'` →
 * `Replay.replayEntities(...)`, `Recognizer.resolve(...)`.
 */
export * as Recognizer from './recognizer.ts'
export * as Replay from './replay-entities.ts'
