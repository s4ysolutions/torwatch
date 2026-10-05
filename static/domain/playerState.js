import { emitter } from '../util/events.js';

export const playerState = emitter({
  phase: 'idle',
  magnetId: null,
  fileIndex: 0,
  position: 0,
  duration: 0,
  error: null,
  note: null, // cacheFile sets `note` on quota-degrade; keep key present
});
