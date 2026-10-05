import { tracks } from '../domain/tracks.js';

// Thin delegation to msePlayer.setAudioTrack + tracks sync.
export async function switchAudio({ player, trackNumber }) {
  if (player && typeof player.setAudioTrack === 'function') {
    await player.setAudioTrack(trackNumber);
  }
  tracks.set({ ...tracks.get(), activeAudio: trackNumber });
  return trackNumber;
}
