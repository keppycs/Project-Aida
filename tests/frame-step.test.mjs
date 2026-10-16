import assert from "node:assert/strict";
import test from "node:test";
import { createFrameStepper, parseFrameRate } from "../web/js/player/frame-step.js";

class Video extends EventTarget {
  constructor({ time = 1, duration = 10, autoSeek = true } = {}) {
    super();
    this.time = time;
    this.duration = duration;
    this.autoSeek = autoSeek;
    this.paused = false;
    this.seeking = false;
    this.targets = [];
  }
  pause() { this.paused = true; }
  get currentTime() { return this.time; }
  set currentTime(value) {
    this.time = Math.floor(value * 1_000_000) / 1_000_000;
    this.targets.push(this.time);
    this.seeking = true;
    if (this.autoSeek) queueMicrotask(() => this.finishSeek());
  }
  finishSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event("seeked"));
  }
}

test("source frame rate accepts exact fractional rates and rejects missing rates", () => {
  assert.equal(parseFrameRate("120000/1001"), 120000 / 1001);
  assert.equal(parseFrameRate("120"), 120);
  for (const rate of [undefined, null, "", 0, -1, NaN, Infinity, "120/0", "x", "1/2/3"]) {
    assert.equal(parseFrameRate(rate), null);
  }
});

test("comma/period stepping pauses and changes exactly one 120 fps source frame", async () => {
  const video = new Video();
  const frames = createFrameStepper(video, { getFrameRate: () => 120 });
  const forward = await frames.step(1);
  assert.equal(video.paused, true);
  assert.equal(forward.frameIndex, 121);
  assert.equal(Math.floor(video.currentTime * 120), 121);
  const back = await frames.step(-1);
  assert.equal(back.frameIndex, 120);
  assert.equal(Math.floor(video.currentTime * 120), 120);
});

test("fractional rates use source cadence independently of playback speed", async () => {
  const rate = 120000 / 1001;
  const video = new Video({ time: 120 / rate });
  video.playbackRate = 2;
  const frames = createFrameStepper(video, { getFrameRate: () => "120000/1001" });
  const result = await frames.step(1);
  assert.equal(result.frameIndex, 121);
  assert.equal(Math.floor(video.currentTime * rate), 121);
  assert.equal(video.playbackRate, 2);
});

test("a native microsecond-rounded boundary never repeats the previous frame", async () => {
  const video = new Video({ time: Math.floor(10 / 120 * 1_000_000) / 1_000_000 });
  const frames = createFrameStepper(video, { getFrameRate: () => 120 });
  assert.equal((await frames.step(1)).frameIndex, 11);
  assert.equal(Math.floor(video.currentTime * 120), 11);
});

test("rapid frame requests accumulate while each seek completes in order", async () => {
  const video = new Video({ autoSeek: false });
  const frames = createFrameStepper(video, { getFrameRate: () => 120 });
  const first = frames.step(1);
  const second = frames.step(1);
  const third = frames.step(-1);
  await Promise.resolve();
  assert.equal(video.targets.length, 1);
  video.finishSeek();
  assert.equal((await first).frameIndex, 121);
  await Promise.resolve();
  assert.equal(video.targets.length, 2);
  video.finishSeek();
  assert.equal((await second).frameIndex, 122);
  await Promise.resolve();
  assert.equal(video.targets.length, 3);
  video.finishSeek();
  assert.equal((await third).frameIndex, 121);
});

test("frame stepping clamps to the first and final available frames", async () => {
  const video = new Video({ time: 0, duration: 1 });
  const frames = createFrameStepper(video, { getFrameRate: () => 120 });
  assert.equal((await frames.step(-1)).frameIndex, 0);
  frames.reset();
  video.time = 1;
  assert.equal((await frames.step(1)).frameIndex, 119);
  assert.equal(Math.floor(video.currentTime * 120), 119);
  assert.equal(video.paused, true);
});

test("unknown source rate pauses without inventing a frame rate or seeking", async () => {
  const video = new Video();
  const frames = createFrameStepper(video, { getFrameRate: () => null });
  assert.deepEqual(await frames.step(1), { ok: false, reason: "unknown-frame-rate" });
  assert.equal(video.paused, true);
  assert.deepEqual(video.targets, []);
});

test("non-finite or unavailable duration cannot produce a seek", async () => {
  for (const duration of [NaN, Infinity, 0]) {
    const video = new Video({ duration });
    const frames = createFrameStepper(video, { getFrameRate: () => 120 });
    assert.equal((await frames.step(1)).reason, "not-ready");
    assert.deepEqual(video.targets, []);
  }
});

test("reset cancels queued seeks and ordinary seeking establishes a new cursor", async () => {
  const video = new Video({ autoSeek: false });
  const frames = createFrameStepper(video, { getFrameRate: () => 120 });
  const first = frames.step(1);
  const second = frames.step(1);
  await Promise.resolve();
  frames.reset();
  assert.equal((await first).reason, "cancelled");
  assert.equal((await second).reason, "cancelled");
  video.time = 2;
  video.autoSeek = true;
  assert.equal((await frames.step(1)).frameIndex, 241);
});

test("resuming playback resets the paused frame cursor", async () => {
  const video = new Video();
  const frames = createFrameStepper(video, { getFrameRate: () => 120 });
  await frames.step(1);
  video.dispatchEvent(new Event("play"));
  video.time = 3;
  assert.equal((await frames.step(-1)).frameIndex, 359);
});

test("a changed source frame rate resets the accumulated cursor", async () => {
  const video = new Video();
  let rate = 120;
  const frames = createFrameStepper(video, { getFrameRate: () => rate });
  await frames.step(1);
  rate = 120000 / 1001;
  video.time = 2;
  assert.equal((await frames.step(1)).frameIndex, Math.floor((2 + 0.000001) * rate) + 1);
});

test("a failed seek times out without allowing stale queued frame requests", async () => {
  const video = new Video({ autoSeek: false });
  const frames = createFrameStepper(video, { getFrameRate: () => 120, seekTimeoutMs: 5 });
  const first = frames.step(1);
  const second = frames.step(1);
  assert.equal((await first).reason, "seek-timeout");
  assert.equal((await second).reason, "cancelled");
  assert.equal(video.targets.length, 1);
});
