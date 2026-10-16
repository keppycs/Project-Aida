const MICROSECOND = 1 / 1_000_000;

/** A source rate, never the display refresh rate or playback speed. */
export function parseFrameRate(value) {
  if (typeof value === "string" && value.includes("/")) {
    const parts = value.split("/");
    if (parts.length !== 2) return null;
    value = Number(parts[0]) / Number(parts[1]);
  }
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Keep a frame cursor separate from currentTime while seeks are in flight.
 * Every key press advances that cursor; seeks run in order rather than losing
 * repeated presses to the browser's asynchronous seek completion.
 */
export function createFrameStepper(video, { getFrameRate, seekTimeoutMs = 4000 } = {}) {
  let generation = 0;
  let requestedFrame = null;
  let requestedRate = null;
  let queue = Promise.resolve();
  let cancelSeek = null;

  function reset() {
    generation += 1;
    requestedFrame = null;
    requestedRate = null;
    cancelSeek?.();
  }

  video.addEventListener("play", reset);
  video.addEventListener("emptied", reset);

  function seek(time, token) {
    return new Promise((resolve) => {
      let timer;
      const finish = (reason = null) => {
        clearTimeout(timer);
        video.removeEventListener("seeked", complete);
        video.removeEventListener("error", failed);
        if (cancelSeek === cancel) cancelSeek = null;
        resolve(reason);
      };
      const complete = () => finish();
      const failed = () => finish("seek-failed");
      const cancel = () => finish("cancelled");
      cancelSeek = cancel;
      video.addEventListener("seeked", complete);
      video.addEventListener("error", failed);
      timer = setTimeout(() => finish("seek-timeout"), seekTimeoutMs);
      try {
        if (token !== generation) return cancel();
        // Chromium stores native seek positions at microsecond precision. Seek
        // just inside the requested frame, never below its rounded boundary.
        video.currentTime = time;
        if (!video.seeking) queueMicrotask(complete);
      } catch {
        failed();
      }
    });
  }

  function step(direction) {
    if (direction !== 1 && direction !== -1) {
      return Promise.reject(new RangeError("Frame direction must be -1 or 1"));
    }
    video.pause();
    const frameRate = parseFrameRate(getFrameRate?.());
    if (!frameRate) return Promise.resolve({ ok: false, reason: "unknown-frame-rate" });
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(video.currentTime)) {
      return Promise.resolve({ ok: false, reason: "not-ready" });
    }
    if (requestedRate !== frameRate) reset();
    requestedRate = frameRate;
    const lastFrame = Math.max(0, Math.ceil(duration * frameRate - 1e-7) - 1);
    // A previous exact boundary can be rounded downward by up to a microsecond.
    const currentFrame = requestedFrame ?? Math.floor((video.currentTime + MICROSECOND) * frameRate);
    requestedFrame = Math.max(0, Math.min(lastFrame, currentFrame + direction));
    const frameIndex = requestedFrame;
    const token = generation;
    const start = Math.ceil(frameIndex / frameRate * 1_000_000) * MICROSECOND;
    const time = frameIndex === 0 ? 0 : Math.min(duration - MICROSECOND, start + MICROSECOND);
    const operation = queue.then(async () => {
      if (token !== generation) return { ok: false, reason: "cancelled" };
      const reason = await seek(time, token);
      if (reason) {
        if (token === generation) reset();
        return { ok: false, reason };
      }
      return { ok: true, frameIndex, time, frameRate };
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return { step, reset };
}
