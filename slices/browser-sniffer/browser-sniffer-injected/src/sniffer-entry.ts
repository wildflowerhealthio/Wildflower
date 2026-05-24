// Entry point used by `scripts/build-sniffer-script.mjs` to produce the
// self-invoking IIFE bundle injected into sniffed pages. Splitting the
// invocation out of `install-sniffer.ts` keeps that file's named
// exports unencumbered and makes the build a single-entry bundle.
import { installSniffer } from './install-sniffer.ts'

installSniffer()
