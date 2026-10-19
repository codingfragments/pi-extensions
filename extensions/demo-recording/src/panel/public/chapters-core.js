// The pure part of the chapter list (no browser imports, so tests can load it).
/** m:ss.s for a take time in ms (a frame moment needs the tenth). */
export const clock = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

/** The index of the frame the playhead is at: the last one at or before it (-1 before the first). */
export function frameAt(frames, ms) {
  let at = -1;
  for (let i = 0; i < frames.length; i++) if (frames[i].t <= ms) at = i;
  return at;
}

/** The chapter the playhead is in: the last scene that has started (-1 before the first). */
export function chapterAt(scenes, ms) {
  let at = -1;
  for (let i = 0; i < scenes.length; i++) if (scenes[i].startMs <= ms) at = i;
  return at;
}
