export const playerMetadata = {
  id: "ui-regression", title: "Player UI regression · 120 fps", duration: 120,
  frameRate: 120, codecs: ["AV1", "HEVC"], colorTransfer: "bt709",
  visibility: "public", createdAt: 1792108800,
};

// A deterministic media backend, served in place of the Shaka CDN script.
// The real watch page, player modules, DOM, styles and browser input stay in use.
export function installPlayerFixture() {
  Object.defineProperty(navigator, "mediaCapabilities", {
    configurable: true, value: { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }) },
  });
  const fixture = window.__aidaFixture = { loads: [], nextLoad: null };
  class Player extends EventTarget {
    static isBrowserSupported() { return true; }
    async attach(video) {
      this.video = video;
      const state = this.state = { currentTime: 0, duration: 120, paused: true, ended: false, volume: 1, muted: false, playbackRate: 1 };
      const emit = (type) => video.dispatchEvent(new Event(type));
      for (const key of Object.keys(state)) {
        Object.defineProperty(video, key, {
          configurable: true, get: () => state[key], set: (value) => {
            state[key] = value;
            if (key === "currentTime") { emit("timeupdate"); emit("seeked"); }
            if (key === "volume" || key === "muted") emit("volumechange");
            if (key === "playbackRate") emit("ratechange");
          },
        });
      }
      Object.defineProperty(video, "buffered", { configurable: true, get: () => ({ length: 1, end: () => 90 }) });
      video.play = async () => {
        if (state.ended) { state.ended = false; video.currentTime = 0; }
        if (!state.paused) return;
        state.paused = false; emit("play"); emit("playing");
      };
      video.pause = () => {
        if (state.paused) return;
        state.paused = true; emit("pause");
      };
      fixture.setTime = (time) => { video.currentTime = time; };
      fixture.setDuration = (duration) => { state.duration = duration; emit("loadedmetadata"); };
      fixture.end = () => {
        video.currentTime = state.duration; state.ended = true; video.pause(); emit("ended");
      };
      fixture.holdNextLoad = () => {
        fixture.nextLoad = new Promise((resolve) => { fixture.releaseLoad = resolve; });
      };
    }
    configure() {}
    getVariantTracks() {
      return [
        { id: 1, height: 2160, bandwidth: 20_000_000, frameRate: 120, active: this.active !== 2 },
        { id: 2, height: 1080, bandwidth: 8_000_000, frameRate: 120, active: this.active === 2 },
      ];
    }
    selectVariantTrack(track) { this.active = track.id; this.dispatchEvent(new Event("variantchanged")); }
    async load(src, startTime) {
      const pending = fixture.nextLoad;
      fixture.nextLoad = null;
      fixture.loads.push({ src, startTime });
      if (fixture.loads.length > 1) {
        this.video.pause(); this.video.volume = 1; this.video.muted = false; this.video.playbackRate = 1;
      }
      if (pending) await pending;
      this.video.currentTime = startTime ?? 0;
      this.video.dispatchEvent(new Event("loadedmetadata"));
      this.dispatchEvent(new Event("trackschanged"));
      this.dispatchEvent(new Event("adaptation"));
    }
  }
  window.shaka = { Player, polyfill: { installAll() {} }, util: { Error: { Severity: { CRITICAL: 2 } } } };
}

export const shakaFixtureScript = `(${installPlayerFixture.toString()})();`;
