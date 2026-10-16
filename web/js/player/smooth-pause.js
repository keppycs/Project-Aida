const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ease = (value) => value * value * (3 - 2 * value);

/**
 * A short transport envelope, independent of the source's frame rate/renditions.
 * UI and persistence must read nominalRate/nominalVolume, never the transient
 * media properties. Ordinary seek, stepping, source and lifecycle actions cancel
 * the envelope; only deliberate play/pause commands use it.
 */
export function createSmoothPause(video, {
  enabled = false,
  durationMs = 140,
  onStateChange = () => {},
  onError = () => {},
  now = () => performance.now(),
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (frame) => cancelAnimationFrame(frame),
  documentTarget = globalThis.document,
  pageTarget = globalThis.window,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  baseUrl = globalThis.document?.baseURI,
} = {}) {
  let active = Boolean(enabled);
  let nominalRate = positiveRate(video.playbackRate);
  let nominalVolume = clamp(Number(video.volume) || 0, 0, 1);
  let appliedRate = video.playbackRate;
  let appliedVolume = video.volume;
  let intendedPaused = video.paused;
  let mix = video.paused ? 0 : 1;
  let frame = null;
  let transition = null;
  let generation = 0;
  let destroyed = false;
  let audioContext = null;
  let audioSource = null;
  let gainNode = null;
  let audioReady = null;
  const listeners = [];

  function positiveRate(value) {
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function notify() {
    onStateChange({ paused: intendedPaused, transitioning: transition !== null });
  }

  function listen(target, type, callback) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }

  function writeRate(value) {
    appliedRate = value;
    if (video.playbackRate === value) return;
    try { video.playbackRate = value; }
    catch {
      // Some transports reject temporary rates. A failed rate ramp must never
      // strand playback or replace the user's selected speed.
      appliedRate = video.playbackRate;
    }
  }

  function writeVolume(value) {
    appliedVolume = value;
    if (video.volume === value) return;
    try { video.volume = value; }
    catch { appliedVolume = video.volume; }
  }

  function writeGain(value, immediate = false) {
    if (!gainNode) return;
    const gain = gainNode.gain;
    const time = audioContext.currentTime;
    gain.cancelScheduledValues(time);
    gain.setValueAtTime(gain.value, time);
    if (immediate) gain.setValueAtTime(value, time);
    else gain.linearRampToValueAtTime(value, time + 0.012);
  }

  function applyMix(value, immediateGain = false) {
    mix = clamp(value, 0, 1);
    // Avoid zero/negative playbackRate and the commonly muted extreme rates.
    // The final stop is a real pause after the audio envelope reaches silence.
    const floor = Math.min(nominalRate, 0.25);
    writeRate(floor + (nominalRate - floor) * mix);
    if (gainNode) {
      writeVolume(nominalVolume);
      writeGain(mix, immediateGain);
    } else {
      writeVolume(nominalVolume * mix);
    }
  }

  function restore() {
    writeRate(nominalRate);
    writeVolume(nominalVolume);
    // A smooth-paused element stays silent in the audio graph. Restoring unity
    // in the same task as pause() can outrun the audio thread's pause command.
    writeGain(active && intendedPaused ? 0 : 1, true);
  }

  function clearTransition() {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    transition = null;
  }

  function cancel({ pause = false } = {}) {
    generation += 1;
    clearTransition();
    intendedPaused = pause || video.paused;
    if (pause) video.pause();
    mix = intendedPaused ? 0 : 1;
    restore();
    notify();
  }

  function safeForAudioGraph() {
    // The Web Audio specification requires silence for CORS-cross-origin
    // sources. Never irreversibly reroute an unapproved remote media element.
    if (video.srcObject) return true;
    const src = video.currentSrc || video.src;
    if (!src) return false;
    try {
      const source = new URL(src, baseUrl);
      const origin = new URL(baseUrl).origin;
      return source.origin === origin || Boolean(video.crossOrigin);
    } catch { return false; }
  }

  function prepareAudio() {
    if (!AudioContextClass || !safeForAudioGraph() || destroyed) return Promise.resolve(false);
    if (audioReady) return audioReady;
    try {
      audioContext ||= new AudioContextClass({ latencyHint: "interactive" });
      // Resume synchronously from the play/toggle gesture before any await.
      const resume = audioContext.state === "running" ? undefined : audioContext.resume();
      audioReady = Promise.resolve(resume).then(() => {
        if (destroyed || audioContext.state !== "running") return false;
        if (!gainNode) {
          const nextGain = audioContext.createGain();
          // Source creation reroutes the element permanently. Connect a complete
          // output graph in the same task and keep it at unity when disabled.
          nextGain.gain.setValueAtTime(active ? mix : 1, audioContext.currentTime);
          nextGain.connect(audioContext.destination);
          const source = audioContext.createMediaElementSource(video);
          source.connect(nextGain);
          audioSource = source;
          gainNode = nextGain;
          writeVolume(nominalVolume);
        }
        return true;
      }).catch(() => false).finally(() => { audioReady = null; });
      return audioReady;
    } catch { return Promise.resolve(false); }
  }

  function finish(target) {
    clearTransition();
    mix = target;
    if (target === 0) video.pause();
    // Audio is already silent when pause() runs. Restore the user's actual
    // properties afterwards so paused controls never display an envelope value.
    restore();
    notify();
  }

  function animateTo(target) {
    clearTransition();
    if (Math.abs(target - mix) < 1e-6) return finish(target);
    const start = mix;
    const started = now();
    const length = Math.max(1, durationMs * Math.abs(target - start));
    transition = { target };
    notify();
    const tick = () => {
      if (destroyed || !transition || transition.target !== target) return;
      const elapsed = clamp((now() - started) / length, 0, 1);
      applyMix(start + (target - start) * ease(elapsed));
      if (elapsed === 1) finish(target);
      else frame = requestFrame(tick);
    };
    frame = requestFrame(tick);
  }

  function play() {
    if (destroyed) return Promise.resolve(false);
    const token = ++generation;
    clearTransition();
    intendedPaused = false;
    const smoothing = active && !video.ended;
    if (smoothing) {
      void prepareAudio();
      const fromPaused = video.paused;
      if (fromPaused) mix = 0;
      // A paused graph may be at unity after Off→On. Silence it synchronously
      // before native play(), rather than scheduling a brief audible ramp down.
      applyMix(mix, fromPaused);
    } else {
      mix = 1;
      restore();
      if (gainNode) void prepareAudio();
    }
    notify();
    let playing;
    try { playing = video.play(); }
    catch (error) { playing = Promise.reject(error); }
    return Promise.resolve(playing).then(() => {
      if (token !== generation || destroyed) {
        if (intendedPaused) video.pause();
        return false;
      }
      if (smoothing && active) animateTo(1);
      else { restore(); notify(); }
      return true;
    }).catch((error) => {
      if (token !== generation || destroyed) return false;
      cancel({ pause: true });
      onError(error);
      return false;
    });
  }

  function pause() {
    if (destroyed) return;
    generation += 1;
    intendedPaused = true;
    if (!active || video.paused || video.ended) return cancel({ pause: true });
    void prepareAudio();
    animateTo(0);
  }

  function setEnabled(value) {
    active = Boolean(value);
    if (!active) cancel({ pause: intendedPaused });
    else {
      void prepareAudio();
      notify();
    }
  }

  function setRate(value) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError("Playback speed must be positive");
    nominalRate = value;
    if (transition) applyMix(mix);
    else writeRate(nominalRate);
  }

  function setVolume(value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError("Volume must be between zero and one");
    nominalVolume = value;
    if (transition) applyMix(mix);
    else writeVolume(nominalVolume);
  }

  listen(video, "ratechange", () => {
    if (Math.abs(video.playbackRate - appliedRate) < 1e-7) return;
    nominalRate = positiveRate(video.playbackRate);
    appliedRate = video.playbackRate;
    if (transition) applyMix(mix);
  });
  listen(video, "volumechange", () => {
    if (Math.abs(video.volume - appliedVolume) < 1e-7) return;
    nominalVolume = clamp(video.volume, 0, 1);
    appliedVolume = video.volume;
    if (transition) applyMix(mix);
  });
  listen(video, "pause", () => {
    // Native/system pauses bypass the visual transport envelope immediately.
    if (!transition && intendedPaused) return;
    cancel();
  });
  listen(video, "play", () => {
    if (!intendedPaused) return;
    cancel();
  });
  listen(video, "seeking", () => {
    // Native play()/seek events are queued independently. With no active ramp,
    // a stale intent must never turn an otherwise ordinary seek into a pause.
    if (transition) cancel({ pause: intendedPaused });
  });
  for (const type of ["ended", "error", "emptied", "abort"]) {
    listen(video, type, () => cancel({ pause: true }));
  }
  listen(documentTarget, "visibilitychange", () => {
    // Also invalidate a pending play promise: it may settle after rAF has been
    // suspended, before a transition has had the chance to schedule its frame.
    if (documentTarget.hidden) cancel({ pause: intendedPaused });
  });
  listen(pageTarget, "pagehide", () => cancel({ pause: true }));

  return {
    play,
    pause,
    toggle: () => intendedPaused ? play() : pause(),
    cancel,
    setEnabled,
    setRate,
    setVolume,
    get enabled() { return active; },
    get intendedPaused() { return intendedPaused; },
    get transitioning() { return transition !== null; },
    get nominalRate() { return nominalRate; },
    get nominalVolume() { return nominalVolume; },
    get audioMode() { return gainNode ? "gain" : "volume"; },
    destroy() {
      cancel({ pause: true });
      destroyed = true;
      for (const remove of listeners) remove();
      // An existing media source cannot be detached back to native output.
      // Keep a connected unity graph until the element's owner removes it.
      if (audioSource && gainNode) writeGain(1, true);
    },
  };
}
