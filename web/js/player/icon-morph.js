const SVG_NS = "http://www.w3.org/2000/svg";
const DURATION_MS = 200;

// Matching corner topology lets the two halves of a solid triangle become bars.
function quad(vertices, radius = 0) {
  return vertices.flatMap(([x, y], index) => {
    const toward = ([otherX, otherY]) => {
      const length = Math.hypot(otherX - x, otherY - y);
      const fraction = length ? Math.min(radius / length, 0.5) : 0;
      return [x + (otherX - x) * fraction, y + (otherY - y) * fraction];
    };
    return [...toward(vertices[(index + 3) % 4]), x, y, ...toward(vertices[(index + 1) % 4])];
  });
}

function quadPath(values, offset) {
  let d = `M${values[offset]} ${values[offset + 1]}`;
  for (let corner = 0; corner < 4; corner++) {
    const i = offset + corner * 6;
    if (corner) d += `L${values[i]} ${values[i + 1]}`;
    d += `Q${values[i + 2]} ${values[i + 3]} ${values[i + 4]} ${values[i + 5]}`;
  }
  return `${d}Z`;
}

const transportPath = values => quadPath(values, 0) + quadPath(values, 24);
const wavePath = values => `M${values[0]} ${values[1]}C${values.slice(2, 8).join(" ")}`;
const CONTROL_SHAPES = {
  play: [...quad([[5, 3], [12, 7.5], [12, 16.5], [5, 21]]), ...quad([[12, 7.5], [19, 12], [19, 12], [12, 16.5]])],
  pause: [...quad([[6, 4], [10, 4], [10, 20], [6, 20]]), ...quad([[14, 4], [18, 4], [18, 20], [14, 20]])],
};
const CENTER_SHAPES = {
  play: [...quad([[26.5, 21.5], [39.5, 28.75], [39.5, 43.25], [26.5, 50.5]]), ...quad([[39.5, 28.75], [52.5, 36], [52.5, 36], [39.5, 43.25]])],
  pause: [...quad([[24, 22], [33, 22], [33, 50], [24, 50]], 2.5), ...quad([[39, 22], [48, 22], [48, 50], [39, 50]], 2.5)],
};
// Last coordinate is opacity. Low volume retracts the outer wave to a point;
// muting bends the waves themselves into the two straight strokes of a cross.
const OUTER_WAVE = {
  full: [19.07, 4.93, 22.975, 8.835, 22.975, 15.165, 19.07, 19.07, 1],
  low: [18.8, 12, 18.8, 12, 18.8, 12, 18.8, 12, 0],
  muted: [17, 9, 19, 11, 21, 13, 23, 15, 1],
};
const INNER_WAVE = {
  full: [15.54, 8.46, 17.493, 10.413, 17.493, 13.577, 15.54, 15.53, 1],
  low: [15.54, 8.46, 17.493, 10.413, 17.493, 13.577, 15.54, 15.53, 1],
  muted: [23, 9, 21, 11, 19, 13, 17, 15, 1],
};

function appendPath(svg, fill) {
  const path = document.createElementNS(SVG_NS, "path");
  path.dataset.morphPath = "";
  if (fill) path.setAttribute("fill", fill);
  svg.append(path);
  return path;
}

function createMorph(svg, tracks, initialState, reducedMotion) {
  let state = initialState;
  let frame = null;
  let started = 0;
  const current = tracks.map(track => [...track.shapes[state]]);
  let from = current;

  function paint() {
    tracks.forEach((track, index) => {
      track.path.setAttribute("d", track.format(current[index]));
      if (track.opacity) track.path.setAttribute("opacity", current[index][8]);
    });
  }

  function settle() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    tracks.forEach((track, index) => { current[index] = [...track.shapes[state]]; });
    paint();
  }

  function tick(now) {
    frame = null;
    const progress = Math.min(1, (now - started) / DURATION_MS);
    const eased = progress * progress * (3 - 2 * progress);
    tracks.forEach((track, index) => {
      const target = track.shapes[state];
      current[index] = from[index].map((value, coordinate) => value + (target[coordinate] - value) * eased);
    });
    paint();
    if (progress < 1) frame = requestAnimationFrame(tick);
  }

  svg.dataset.iconState = state;
  paint();
  return {
    set(next) {
      if (state === next) return;
      state = next;
      svg.dataset.iconState = state;
      if (reducedMotion.matches || document.hidden) return settle();
      if (frame !== null) cancelAnimationFrame(frame);
      // Start from the painted geometry, with no endpoint snap or DOM swap.
      from = current.map(values => [...values]);
      started = performance.now();
      frame = requestAnimationFrame(tick);
    },
    settle,
  };
}

export function createPlayerIcons({ playIcon, bigPlay, volumeIcon, playing, volumeState }) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const centerSvg = bigPlay.querySelector("svg");
  // Preserve the existing center disc and speaker body; only the glyphs morph.
  playIcon.replaceChildren();
  centerSvg.querySelectorAll(":scope > :not(circle)").forEach(node => node.remove());
  volumeIcon.querySelectorAll(":scope > :not(polygon)").forEach(node => node.remove());
  const initial = playing ? "pause" : "play";
  const play = createMorph(playIcon, [{ path: appendPath(playIcon), shapes: CONTROL_SHAPES, format: transportPath }], initial, reducedMotion);
  const center = createMorph(centerSvg, [{ path: appendPath(centerSvg, "rgba(255,255,255,0.88)"), shapes: CENTER_SHAPES, format: transportPath }], initial, reducedMotion);
  const volume = createMorph(volumeIcon, [
    { path: appendPath(volumeIcon), shapes: OUTER_WAVE, format: wavePath, opacity: true },
    { path: appendPath(volumeIcon), shapes: INNER_WAVE, format: wavePath, opacity: true },
  ], volumeState, reducedMotion);
  const settle = () => { play.settle(); center.settle(); volume.settle(); };
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) settle(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) settle(); });
  window.addEventListener("pagehide", settle);
  return {
    setPlaying(value) { play.set(value ? "pause" : "play"); },
    setCenterPlaying(value) { center.set(value ? "pause" : "play"); },
    setVolume(state) { volume.set(state); },
  };
}
