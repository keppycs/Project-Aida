import assert from "node:assert/strict";
import test from "node:test";
import { rememberBrowsePosition, requestBrowseReturn, takeBrowseReturn, videosUrl } from "../web/js/browse-context.js";

test("tab-local return validates the context, consumes once, and needs deliberate return", () => {
  const data = new Map();
  const globals = ["sessionStorage", "scrollY", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  try {
    Object.defineProperties(globalThis, {
      sessionStorage: { configurable: true, value: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) } },
      scrollY: { configurable: true, value: 900 },
      document: { configurable: true, value: { getElementById: () => ({ getBoundingClientRect: () => ({ top: -100 }) }) } },
    });
    const card = { href: "https://fixture.invalid/watch?v=example", classList: { contains: () => true }, getBoundingClientRect: () => ({ top: 80 }) };
    rememberBrowsePosition("CS2", card);
    assert.equal(takeBrowseReturn("CS2"), null);
    requestBrowseReturn("changed");
    assert.equal(takeBrowseReturn("changed"), null);
    requestBrowseReturn("CS2");
    assert.deepEqual(takeBrowseReturn("CS2"), { query: "CS2", id: "example", y: 900, offset: 80, hero: false, pending: true });
    assert.equal(takeBrowseReturn("CS2"), null);
    rememberBrowsePosition("CS2", card);
    assert.equal(takeBrowseReturn("CS2", true).y, 900, "Native history return can consume an unmarked handoff");
    assert.equal(takeBrowseReturn("CS2", true), null);
    rememberBrowsePosition("CS2", card); requestBrowseReturn("CS2");
    assert.equal(takeBrowseReturn("LC"), null);
    assert.equal(takeBrowseReturn("CS2"), null, "Changing context consumes an obsolete return");
    for (const invalid of ["broken", '{"query":"CS2","id":"example","y":-1,"offset":0,"pending":true}', '{"query":"CS2","id":"example","y":0,"pending":true}']) {
      data.set("aida-browse-return", invalid);
      assert.equal(takeBrowseReturn("CS2"), null);
    }
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("Storage blocked"); } });
    assert.doesNotThrow(() => rememberBrowsePosition("CS2", card));
    assert.doesNotThrow(() => requestBrowseReturn("CS2"));
    assert.equal(takeBrowseReturn("CS2"), null);
    assert.equal(videosUrl("CS2"), "./?q=CS2");
  } finally {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
