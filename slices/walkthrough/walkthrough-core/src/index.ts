export type { WalkthroughStorage } from './seen-walkthrough.ts'
export {
  readSeenWalkthrough,
  SeenWalkthrough,
  seenWalkthroughStorageKey,
  WalkthroughOutcome,
  writeSeenWalkthrough,
} from './seen-walkthrough.ts'
export type { WalkthroughStep } from './walkthrough-step.ts'
export { WALKTHROUGH_ANCHOR_ATTRIBUTE, walkthroughAnchor } from './walkthrough-step.ts'
