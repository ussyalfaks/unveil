// Browser-only helpers (they touch the DOM, camera and canvas).
export { openPeephole } from './peephole.js';
export type { PeepholeOptions } from './peephole.js';
export { startCamera, stopCamera, capturePhoto } from './capture.js';
export type { CapturedPhoto } from './capture.js';
