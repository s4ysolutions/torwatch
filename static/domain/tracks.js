import { emitter } from '../util/events.js';

export const tracks = emitter({
  audio: [],
  subtitles: [],
  activeAudio: null,
  activeSubtitle: null,
});
