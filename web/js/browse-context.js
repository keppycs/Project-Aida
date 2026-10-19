/** Carry only a search query, never a free-form return URL or visitor identifier. */
export function browseQuery(search = "") { return new URLSearchParams(search).get("q") || ""; }

export function videosUrl(query = "") {
  return query.trim() ? `./?q=${encodeURIComponent(query)}` : "./";
}

export function withBrowseQuery(url, query = "") {
  if (!query.trim()) return url;
  const [path, search = ""] = url.split("?");
  const params = new URLSearchParams(search);
  params.set("q", query);
  return `${path}?${params}`;
}

// One tab-local handoff for a deliberate return to the same browsing task.
// No visitor identifier, network request, or durable search history is stored.
const POSITION_KEY = "aida-browse-return";
function savedPosition() {
  try {
    const value = JSON.parse(sessionStorage.getItem(POSITION_KEY));
    return value && typeof value.query === "string" && typeof value.id === "string"
      && Number.isFinite(value.y) && value.y >= 0 && Number.isFinite(value.offset) ? value : null;
  } catch { return null; }
}
export function rememberBrowsePosition(query, link) {
  try {
    const id = new URL(link.href).searchParams.get("v");
    if (!id) return;
    const anchor = link.classList.contains("video-card") ? link : document.getElementById("hero-content");
    sessionStorage.setItem(POSITION_KEY, JSON.stringify({ query, id, y: scrollY, offset: anchor.getBoundingClientRect().top,
      hero: !link.classList.contains("video-card"), pending: false }));
  } catch { /* Query links remain usable when tab storage is unavailable. */ }
}
export function requestBrowseReturn(query) {
  try {
    const value = savedPosition();
    if (value?.query === query) sessionStorage.setItem(POSITION_KEY, JSON.stringify({ ...value, pending: true }));
  } catch {}
}
export function takeBrowseReturn(query, historyReturn = false) {
  try {
    const value = savedPosition();
    if (!value || !value.pending && !historyReturn) return null;
    sessionStorage.removeItem(POSITION_KEY);
    return value.query === query ? value : null;
  } catch { return null; }
}
