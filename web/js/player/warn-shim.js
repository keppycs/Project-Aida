// Suppress noisy Shaka CEA caption warnings (we do not use captions).
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].includes("CEA")) return;
  _origWarn(...args);
};
