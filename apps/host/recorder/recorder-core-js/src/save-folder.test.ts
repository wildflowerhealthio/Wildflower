import { Effect, Either } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../recorder-wire-golden.json' with { type: 'json' }
import { readSaveFolder, SAVE_FOLDER_COMMAND, SaveFolderUnreadable } from './save-folder.ts'

describe('readSaveFolder', () => {
  it('should ask the host for the folder and decode its golden answer', async () => {
    // Arrange
    const asked: string[] = []

    // Act
    const folder = await Effect.runPromise(
      readSaveFolder((command) => {
        asked.push(command)
        return Promise.resolve(golden.commands.recorder_save_folder)
      })
    )

    // Assert
    expect(asked).toEqual([SAVE_FOLDER_COMMAND])
    expect(SAVE_FOLDER_COMMAND).toBe(Object.keys(golden.commands)[0])
    expect(folder).toEqual(golden.commands.recorder_save_folder)
  })

  it("should carry the host's reason when it has no folder", async () => {
    // Act
    const result = await Effect.runPromise(
      Effect.either(readSaveFolder(() => Promise.reject('no recordings folder: no Downloads')))
    )

    // Assert
    expect(result).toEqual(
      Either.left(new SaveFolderUnreadable({ message: 'no recordings folder: no Downloads' }))
    )
  })

  it('should refuse an answer without a path', async () => {
    // Act
    const result = await Effect.runPromise(
      Effect.either(readSaveFolder(() => Promise.resolve({ path: '', revealsFiles: true })))
    )

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })
})
