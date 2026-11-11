import { test } from "node:test";
import assert from "node:assert/strict";
import { searchStatus, askSearch } from "../src/lib/web-search.js";
import { createSearch } from "../src/search/search.mjs";

const pages = async (url) =>
  url.endsWith("/robots.txt")
    ? new Response("", { status: 404 })
    : new Response(`<title>Repo</title><article>${"The repo builds with pnpm. ".repeat(20)}</article>`, { headers: { "content-type": "text/html" } });
const search = createSearch({
  engines: [{ name: "test", search: async () => [{ title: "Repo docs", url: "https://docs.example/build", snippet: "pnpm" }] }],
  fetch: pages,
  chat: async () => "Build it with pnpm [1].",
});

test("@search answers a query or an @search mention with sources", async () => {
  const r = await askSearch({ query: "how do I build it?" }, search);
  assert.equal(r.answer, "Build it with pnpm [1].");
  assert.equal(r.sources[0].url, "https://docs.example/build");
  assert.equal((await askSearch({ text: "@search how do I build it?" }, search)).query, "how do I build it?");
  await assert.rejects(askSearch({ text: "no mention" }, search), (e) => e.status === 400);
});

test("@search is off until a search engine is configured", async () => {
  assert.deepEqual(searchStatus(null), { connected: false, engines: [], answers: false });
  await assert.rejects(askSearch({ query: "x" }, null), (e) => e.status === 503);
  assert.deepEqual(searchStatus(search), { connected: true, engines: ["test"], answers: true });
});
