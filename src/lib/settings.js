// Persisted operator settings. Missing file means every switch is off.
import { load, save } from "./store.js";

const NAME = "settings";

function envOverride(name) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === "") return undefined;
  if (/^(1|true|on|yes)$/i.test(String(v).trim())) return true;
  if (/^(0|false|off|no)$/i.test(String(v).trim())) return false;
  throw new Error(`${name} must be on or off, got "${v}"`);
}

export function getSettings() {
  const raw = load(NAME, { geoRouting: false });
  return { geoRouting: raw?.geoRouting === true };
}

export function setGeoRouting(on) {
  const raw = load(NAME, {});
  const next = { ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}), geoRouting: on === true };
  save(NAME, next);
  return { geoRouting: next.geoRouting === true };
}

/** Effective geo-routing switch. Env overrides the saved value. Default off. */
export function geoEnabled() {
  const env = envOverride("INFINITUM_GEO_ENABLED");
  if (env !== undefined) return env;
  return getSettings().geoRouting === true;
}

export function settingsView() {
  const saved = getSettings();
  const env = envOverride("INFINITUM_GEO_ENABLED");
  return {
    geoRouting: saved.geoRouting,
    effective: env !== undefined ? env : saved.geoRouting,
    envLocked: env !== undefined,
  };
}
