// @search inside 1MIND: Infinitum Search (synced from InfinitumCorp/infinitum-nexus packages/ai,
// don't edit ../search). A web answer with numbered sources for the signed-in owner.
// Off until SEARXNG_URL, YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID or BRAVE_SEARCH_API_KEY is set;
// answers use AI_BASE_URL/AI_API_KEY/AI_MODEL or OMNIROUTE_*.
import { searchFromEnv, parseSearchMention } from "../search/search.mjs";

let shared;
let sharedError = "";
function fromEnv() {
  if (shared === undefined) {
    try {
      shared = searchFromEnv(process.env);
    } catch (e) {
      shared = null;
      sharedError = e.message;
    }
  }
  return shared;
}

/** { connected, engines, answers, error? } — never a URL or key. */
export function searchStatus(search = fromEnv()) {
  return { connected: Boolean(search), engines: search?.engines ?? [], answers: Boolean(search?.answers), ...(sharedError ? { error: sharedError } : {}) };
}

/** Answers { query } or { text: "... @search ..." }. Throws { status } errors for the route. */
export async function askSearch(body, search = fromEnv()) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!search) throw fail(503, "Infinitum Search is not configured: set SEARXNG_URL, YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID, or BRAVE_SEARCH_API_KEY.");
  const query = typeof body?.query === "string" ? body.query : parseSearchMention(body?.text)?.query ?? "";
  if (!query.trim() || query.length > 2000) throw fail(400, "Write a question (1 to 2000 characters).");
  return search.ask(query);
}
