import assets from "./generated/admin-assets.mjs";

/** Called only after owner authentication. No dynamic origin fallback exists. */
export async function serveAdminAsset(request) {
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const url = new URL(request.url);
  const asset = assets[url.pathname];
  if (!asset) return null;
  let body = asset.binary ? Uint8Array.from(atob(asset.body), character => character.charCodeAt(0)) : asset.body;
  if (url.pathname === "/edit/preview/watch.html" && url.searchParams.get("embed") === "1") {
    const css = assets["/edit/assets/preview.css"].body;
    body = body.replace("</head>", `<style id="aida-studio-preview-style">\n${css}\n</style></head>`);
  }
  return new Response(request.method === "HEAD" ? null : body, { headers: { "Content-Type": asset.type, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
