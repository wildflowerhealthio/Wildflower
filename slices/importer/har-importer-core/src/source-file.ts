/**
 * The coding axis an uploaded `.har` file is stored under — the `/source-file`
 * subpath every binding has, so a reader building the cross-format search token
 * asks each format the same question.
 *
 * @remarks
 * HAR's answer is web-trace's coding: a stored HAR archive sits on the same
 * axis as a captured trace, disjoint from it by code. The constants are
 * therefore re-exported rather than declared — this binding owns the *choice*
 * of axis, not the axis.
 *
 * @packageDocumentation
 */
export { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'
