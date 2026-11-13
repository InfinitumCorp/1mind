// The two assistant triggers in 1MIND's intent box. Anything else is a Conjure build intent.
//   @scalvs / @scalus <task>   the SCALVS agent on an OpenClaw gateway        -> /api/scalvs
//   @conjure <question>        a Conjure™ prediction-model forecast           -> /api/predict
// "@openclaw" is not a trigger. @conjure wins when the text has both, the same as +SPCTR.
import { openClawRoutesFromEnv } from "./openclaw/openclaw.mjs";
import { conjureRoutesFromEnv } from "./conjure-forecast/conjure.mjs";

export const SCALVS_MENTION = /(^|[^\w@＠./])[@＠]scal(?:vs|us)(?![\w-]|\.[a-z])/i;
export const CONJURE_MENTION = /(^|[^\w@./])@conjure(?![\w-]|\.[a-z])/i;

export function mentionIn(text) {
  if (typeof text !== "string") return null;
  if (CONJURE_MENTION.test(text)) return "conjure";
  if (SCALVS_MENTION.test(text)) return "scalvs";
  return null;
}

/**
 * Both route handlers, built from the environment. Each is off until configured:
 * OPENCLAW_GATEWAY_URL + OPENCLAW_GATEWAY_TOKEN for @scalvs, CONJURE_URL + CONJURE_PRODUCT_KEY for @conjure.
 */
export function assistRoutes(env = process.env, { fetch } = {}) {
  const scalvs = openClawRoutesFromEnv(env, { prefix: "/api/scalvs", product: "1mind", fetch });
  const predict = conjureRoutesFromEnv(env, { prefix: "/api/predict", source: "1mind" });
  /** Request in, Response out (null for paths it doesn't own). Call after sign-in with the person's CID. */
  return async (request, cid) => (await scalvs(request, { user: cid })) ?? (await predict(request, { user: cid }));
}
