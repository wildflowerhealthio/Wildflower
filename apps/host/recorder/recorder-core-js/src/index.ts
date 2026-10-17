/**
 * The Recorder's pure core: accumulate the browser-sniffer's response events
 * into an `HttpArchive.Log`, emit it as a HAR 1.2 archive, name the file it is
 * saved as, carry the recording's traffic over `RecorderBridge`, read the
 * folder the host saves it into, and read and change the bookmarks the user
 * records from.
 *
 * @packageDocumentation
 */
export {
  addBookmark,
  Bookmark,
  BOOKMARK_ADD_COMMAND,
  BOOKMARK_RECORDED_COMMAND,
  BOOKMARK_REMOVE_COMMAND,
  BOOKMARK_RENAME_COMMAND,
  BOOKMARKS_COMMAND,
  bookmarkUrl,
  BookmarksUnavailable,
  byRecency,
  markBookmarkRecorded,
  readBookmarks,
  removeBookmark,
  renameBookmark,
} from './bookmarks.ts'
export {
  HarSaveFailed,
  HarSaved,
  HttpUrl,
  Open,
  RecorderBridge,
  SaveHar,
  SnifferDisposed,
  SniffingComplete,
  UserDismissed,
} from './bridge.ts'
export { MAX_FILE_NAME_LENGTH, recordingFileName } from './file-name.ts'
export { isOmittedFromRecording } from './omitted.ts'
export {
  type InvokeHostCommand,
  readSaveFolder,
  SAVE_FOLDER_COMMAND,
  SaveFolder,
  SaveFolderUnreadable,
} from './save-folder.ts'
export { MAX_BODY_BYTES, Recording } from './recording.ts'
export { CREATOR_NAME, REQUEST_COMMENT, type ToHarOptions, toHar } from './to-har.ts'
