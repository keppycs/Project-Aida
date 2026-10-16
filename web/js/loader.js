import { videoVisibility } from "./catalog.js?v=ux-stability-v14";

export class VideoLoadError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** Fetch metadata before mounting the player; unavailable videos never expose dead controls. */
export async function loadMetadata(base, { allowPrivate = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${base}/metadata.json`, { signal: controller.signal });
    if (response.status === 404) throw new VideoLoadError("not_found", "Video not found");
    if (!response.ok) throw new VideoLoadError("network", "Unable to load video");
    let meta;
    try {
      meta = await response.json();
    } catch {
      throw new VideoLoadError("invalid", "Video information is unavailable");
    }
    if (!meta || typeof meta !== "object" || Array.isArray(meta) || !Array.isArray(meta.codecs)) {
      throw new VideoLoadError("invalid", "Video information is unavailable");
    }
    if (videoVisibility(meta) === "private" && !allowPrivate) {
      throw new VideoLoadError("private", "This video is private");
    }
    return {
      ...meta,
      title: typeof meta.title === "string" && meta.title.trim() ? meta.title : "Untitled video",
      codecs: meta.codecs.filter((codec) => codec === "AV1" || codec === "HEVC"),
    };
  } catch (error) {
    if (error instanceof VideoLoadError) throw error;
    throw new VideoLoadError("network", "Unable to load video");
  } finally {
    clearTimeout(timeout);
  }
}
