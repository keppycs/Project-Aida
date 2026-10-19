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
