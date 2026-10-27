/** Freeze takes precedence over the selected loop / ping-pong mode. */
export function playbackMode(mode, freezeEnd = false) {
  return freezeEnd ? 'once' : mode;
}

/**
 * Sample at up to 60 fps, retaining frame zero and the terminal frame.
 * The terminal frame lasts one source frame. No frame list is allocated, so
 * long video exports can still stream without keeping their schedule in memory.
 */
export function exportSchedule(lastFrame, fps) {
  const step = Math.max(1, Math.ceil(fps / 60));
  const count = Math.ceil(lastFrame / step) + 1;
  return {
    count,
    fps: fps / step,
    at(i) {
      const frame = Math.min(i * step, lastFrame);
      const end = i + 1 < count ? Math.min((i + 1) * step, lastFrame) : lastFrame + 1;
      return { frame, duration: (end - frame) * 1000 / fps };
    },
  };
}
