import type { HelperSettings, Mission } from "./types.js";

const KEYS = ["contextPack", "failureDigest", "reportProse"] as const;

/** Missing configuration keys default on. A present saved snapshot must be complete. */
export function resolveHelpers(value: unknown, saved = false): HelperSettings {
  if (value === undefined) return { contextPack: true, failureDigest: true, reportProse: true };
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("helpers must contain named boolean settings.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !KEYS.includes(key as typeof KEYS[number]))) throw new Error("helpers contains an unknown setting.");
  const out = { contextPack: true, failureDigest: true, reportProse: true };
  for (const key of KEYS) {
    if (!Object.hasOwn(record, key) && !saved) continue;
    if (typeof record[key] !== "boolean") throw new Error(`helpers.${key} must be true or false.`);
    out[key] = record[key];
  }
  return out;
}

export function missionHelpers(m: Pick<Mission, "helpers">): HelperSettings { return resolveHelpers(m.helpers, true); }

export function helperSettingsLine(m: Pick<Mission, "helpers">): string {
  const settings = missionHelpers(m);
  const on = (value: boolean) => value ? "on" : "off";
  return `Optional helpers: context suggestions ${on(settings.contextPack)}; failure summaries ${on(settings.failureDigest)}; report prose ${on(settings.reportProse)}.`;
}
