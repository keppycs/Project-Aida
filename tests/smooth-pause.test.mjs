import assert from "node:assert/strict";
import test from "node:test";
import { createSmoothPause } from "../web/js/player/smooth-pause.js";

class Media extends EventTarget {
  constructor({ paused = false, rate = 1, volume = 0.6, muted = false, deferredPlay = false } = {}) {
    super();
    this.paused = paused;
    this.rate = rate;
    this.level = volume;
    this.muted = muted;
    this.ended = false;
    this.deferredPlay = deferredPlay;
    this.rateHistory = [];
    this.volumeHistory = [];
    this.pauseCount = 0;
    this.currentSrc = "https://aida.test/video.mp4";
    this.pending = [];
  }
  get playbackRate() { return this.rate; }
  set playbackRate(value) {
    this.rate = value;
    this.rateHistory.push(value);
    queueMicrotask(() => this.dispatchEvent(new Event("ratechange")));
  }
  get volume() { return this.level; }
  set volume(value) {
    this.level = value;
    this.volumeHistory.push(value);
    queueMicrotask(() => this.dispatchEvent(new Event("volumechange")));
  }
  play() {
    if (this.deferredPlay) return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    this.pauseCount += 1;
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.dispatchEvent(new Event("pause"));
  }
}

function fixture(options = {}, controllerOptions = {}) {
  const video = new Media(options);
  const frames = new Map();
  const documentTarget = new EventTarget();
  const pageTarget = new EventTarget();
  let time = 0;
  let nextFrame = 0;
  const controller = createSmoothPause(video, {
    enabled: true,
    durationMs: 200,
    AudioContextClass: null,
    baseUrl: "https://aida.test/watch.html",
    now: () => time,
    requestFrame: (callback) => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame: (id) => frames.delete(id),
    documentTarget,
    pageTarget,
    ...controllerOptions,
  });
  async function tick(ms) {
    time += ms;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(time);
    await Promise.resolve();
  }
  return { video, controller, tick, frames, documentTarget, pageTarget };
}

test("the default pause and resume envelopes settle in 140ms", async () => {
  const { video, controller, tick } = fixture({}, { durationMs: undefined });
  controller.pause();
  await tick(139);
  assert.equal(video.paused, false);
  assert.equal(controller.transitioning, true);
  await tick(1);
  assert.equal(video.paused, true);
  assert.equal(controller.transitioning, false);
  await controller.play();
  await tick(139);
  assert.equal(controller.transitioning, true);
  assert.ok(video.playbackRate < 1);
  await tick(1);
  assert.equal(controller.transitioning, false);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.volume, .6);
});

test("pause eases actual video and audio once, then restores selected properties", async () => {
  const { video, controller, tick, frames } = fixture({ rate: 1.5, volume: 0.7 });
  controller.pause();
  assert.equal(controller.intendedPaused, true);
  assert.equal(video.paused, false, "intent changes immediately; transport settles later");
  await tick(50);
  assert.ok(video.playbackRate > 0.25 && video.playbackRate < 1.5);
  assert.ok(video.volume > 0 && video.volume < 0.7);
  assert.equal(controller.nominalRate, 1.5);
  assert.equal(controller.nominalVolume, 0.7);
  await tick(150);
  assert.equal(video.paused, true);
  assert.equal(video.playbackRate, 1.5);
  assert.equal(video.volume, 0.7);
  assert.equal(video.pauseCount, 1);
  assert.equal(controller.transitioning, false);
  assert.equal(frames.size, 0);
});

test("resume accelerates from silence without changing mute or nominal speed", async () => {
  const { video, controller, tick } = fixture({ paused: true, rate: 2, volume: 0.5, muted: true });
  await controller.play();
  assert.equal(video.paused, false);
  assert.equal(video.playbackRate, 0.25);
  assert.equal(video.volume, 0);
  await tick(100);
  assert.equal(video.playbackRate, 1.125);
  assert.equal(video.volume, 0.25);
  await tick(100);
  assert.equal(video.playbackRate, 2);
  assert.equal(video.volume, 0.5);
  assert.equal(video.muted, true);
});

test("rapid reversal keeps the current envelope and the last requested intent wins", async () => {
  const { video, controller, tick } = fixture();
  controller.pause();
  await tick(70);
  const before = [video.playbackRate, video.volume];
  await controller.play();
  assert.deepEqual([video.playbackRate, video.volume], before);
  await tick(200);
  assert.equal(video.paused, false);
  assert.equal(controller.intendedPaused, false);
  assert.equal(video.playbackRate, 1);
  controller.pause();
  await tick(30);
  await controller.play();
  controller.pause();
  await tick(250);
  assert.equal(video.paused, true);
  assert.equal(controller.intendedPaused, true);
});

test("disabling mid-pause finishes immediately; default-off transport is immediate", async () => {
  const { video, controller, tick } = fixture();
  controller.pause();
  await tick(50);
  controller.setEnabled(false);
  assert.equal(video.paused, true);
  assert.equal(video.volume, 0.6);
  assert.equal(video.playbackRate, 1);
  await controller.play();
  assert.equal(controller.transitioning, false);
  assert.equal(video.playbackRate, 1);
  controller.pause();
  assert.equal(video.paused, true);
  const native = new Media();
  const defaults = createSmoothPause(native, { AudioContextClass: null });
  assert.equal(defaults.enabled, false);
  defaults.pause();
  assert.equal(native.paused, true);
});

test("seek/frame cancellation is immediate and does not later resume", async () => {
  const { video, controller, tick, frames } = fixture({ rate: 1.75, volume: 0.4 });
  controller.pause();
  await tick(60);
  controller.cancel({ pause: true });
  assert.equal(video.paused, true);
  assert.equal(video.playbackRate, 1.75);
  assert.equal(video.volume, 0.4);
  assert.equal(frames.size, 0);
  await tick(500);
  assert.equal(video.paused, true);
});

test("queued native play/seeking events stay transparent with Smooth Pause off", async () => {
  const { video, controller } = fixture({ paused: true }, { enabled: false });
  // HTMLMediaElement.play changes paused synchronously, then queues its play
  // event. A seek event may arrive before that queued event updates our intent.
  video.play = () => {
    video.paused = false;
    queueMicrotask(() => video.dispatchEvent(new Event("play")));
    return Promise.resolve();
  };
  const playing = video.play();
  video.dispatchEvent(new Event("seeking"));
  assert.equal(video.paused, false, "an ordinary seek must not force a native play back to pause");
  await playing;
  assert.equal(controller.intendedPaused, false);
  assert.equal(video.pauseCount, 0);
});

test("source errors, end, native pause and backgrounding cannot strand a ramp", async () => {
  for (const kind of ["error", "ended", "emptied", "abort", "pause", "hidden", "pagehide"]) {
    const { video, controller, tick, documentTarget, pageTarget, frames } = fixture();
    controller.pause();
    await tick(70);
    if (kind === "hidden") {
      documentTarget.hidden = true;
      documentTarget.dispatchEvent(new Event("visibilitychange"));
    } else if (kind === "pagehide") pageTarget.dispatchEvent(new Event("pagehide"));
    else if (kind === "pause") video.pause();
    else video.dispatchEvent(new Event(kind));
    assert.equal(video.paused, true, kind);
    assert.equal(video.playbackRate, 1, kind);
    assert.equal(video.volume, 0.6, kind);
    assert.equal(controller.transitioning, false, kind);
    assert.equal(frames.size, 0, kind);
  }
});

test("speed/volume changes during the envelope become the new nominal selection", async () => {
  const { video, controller, tick } = fixture();
  controller.pause();
  await tick(50);
  controller.setRate(2);
  controller.setVolume(0.3);
  await tick(150);
  assert.equal(video.playbackRate, 2);
  assert.equal(video.volume, 0.3);
  assert.equal(controller.nominalRate, 2);
  assert.equal(controller.nominalVolume, 0.3);
  video.playbackRate = 1.25;
  video.volume = 0.9;
  await Promise.resolve();
  assert.equal(controller.nominalRate, 1.25);
  assert.equal(controller.nominalVolume, 0.9);
});

test("a rejected or stale play promise cannot leave silent running video", async () => {
  const errors = [];
  const { video, controller, tick } = fixture({ paused: true, deferredPlay: true }, { onError: (error) => errors.push(error) });
  const failed = controller.play();
  video.pending.shift().reject(new Error("blocked"));
  assert.equal(await failed, false);
  assert.equal(video.paused, true);
  assert.equal(video.volume, 0.6);
  assert.equal(errors.length, 1);
  const stale = controller.play();
  controller.pause();
  video.paused = false;
  video.pending.shift().resolve();
  assert.equal(await stale, false);
  await tick(500);
  assert.equal(video.paused, true);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.volume, 0.6);
});

test("backgrounding before a pending play settles cannot leave a frozen hidden ramp", async () => {
  const { video, controller, documentTarget, frames } = fixture({ paused: true, deferredPlay: true });
  const playing = controller.play();
  video.paused = false;
  documentTarget.hidden = true;
  documentTarget.dispatchEvent(new Event("visibilitychange"));
  video.pending.shift().resolve();
  assert.equal(await playing, false);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.volume, 0.6);
  assert.equal(controller.transitioning, false);
  assert.equal(frames.size, 0);
});

function audioFixture() {
  const contexts = [];
  class AudioContext {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
      this.sources = 0;
      contexts.push(this);
    }
    resume() { this.state = "running"; return Promise.resolve(); }
    createGain() {
      const gain = { value: 1, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; } };
      this.gain = { gain, connect() {} };
      return this.gain;
    }
    createMediaElementSource() { this.sources += 1; return { connect() {} }; }
  }
  return { AudioContext, contexts };
}

test("Web Audio smooths audio independently of unsupported mobile media volume", async () => {
  const { AudioContext, contexts } = audioFixture();
  const { video, controller, tick } = fixture({}, { AudioContextClass: AudioContext });
  controller.setEnabled(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.audioMode, "gain");
  controller.pause();
  await tick(100);
  assert.equal(video.volume, 0.6, "native/user volume stays constant when using gain");
  assert.equal(contexts[0].gain.gain.value, 0.5);
  await tick(100);
  assert.equal(video.paused, true);
  assert.equal(contexts[0].gain.gain.value, 0, "enabled smooth pause retains silence after the native pause");
  await controller.play();
  await tick(200);
  assert.equal(contexts[0].sources, 1, "the same element is routed only once");
});

test("first resume hands native silence to a silent gain without a one-task audio burst", async () => {
  const { AudioContext, contexts } = audioFixture();
  const { video, controller, tick } = fixture({ paused: true }, { AudioContextClass: AudioContext });
  await controller.play();
  assert.equal(controller.audioMode, "gain");
  assert.equal(contexts[0].gain.gain.value, 0);
  assert.equal(video.volume, 0.6);
  await tick(100);
  assert.equal(contexts[0].gain.gain.value, 0.5);
  await tick(100);
  assert.equal(contexts[0].gain.gain.value, 1);
});

test("enabling while paused and resuming silences gain before the native play call", async () => {
  const { AudioContext, contexts } = audioFixture();
  const { video, controller, tick } = fixture({ paused: true }, { AudioContextClass: AudioContext });
  controller.setEnabled(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(contexts[0].gain.gain.value, 0);
  let gainAtPlay;
  const nativePlay = video.play.bind(video);
  video.play = () => { gainAtPlay = contexts[0].gain.gain.value; return nativePlay(); };
  await controller.play();
  assert.equal(gainAtPlay, 0);
  await tick(200);
  controller.pause();
  await tick(200);
  assert.equal(contexts[0].gain.gain.value, 0);
  controller.setEnabled(false);
  assert.equal(contexts[0].gain.gain.value, 1, "Off restores a transparent unity graph");
});

test("uncorsed cross-origin media never enters an irreversible silent audio graph", async () => {
  const { AudioContext, contexts } = audioFixture();
  const { video, controller } = fixture({}, { AudioContextClass: AudioContext });
  video.currentSrc = "https://remote.test/video.mp4";
  controller.setEnabled(true);
  await Promise.resolve();
  assert.equal(contexts.length, 0);
  assert.equal(controller.audioMode, "volume");
  video.crossOrigin = "anonymous";
  controller.setEnabled(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.audioMode, "gain");
});

test("destroy restores the transport, stops scheduled work, and removes lifecycle handlers", async () => {
  const { video, controller, tick, frames } = fixture();
  controller.pause();
  await tick(50);
  controller.destroy();
  assert.equal(video.paused, true);
  assert.equal(video.volume, 0.6);
  assert.equal(frames.size, 0);
  video.playbackRate = 2;
  await Promise.resolve();
  assert.equal(controller.nominalRate, 1);
});
