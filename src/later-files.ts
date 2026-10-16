// A file that a feature checked by tests made, which a later feature of the same mission is planned to make (real run R6: the plan's contract
// said the notes file and its headings, so the first feature wrote a test of that file and made the file, and the feature that was meant
// to make it only rewrote it). The engine cannot stop that by reading, so it says it: here is the rule, and the sentence the report and the look use.
//
// Text only. The words of the plan are compared with the names of files that git reports; they are never used as a path, never opened and
// never run. Nothing here reads a file.
import { hasModeFeature, isModeFeature } from "./checked-by.js";
import { shown } from "./checkpoint.js";
import type { AlsoMade, Feature, Mission } from "./types.js";

/** At most this many files are kept for one feature. */
const MAX_ALSO_MADE = 5;

/** Plain text for a comparison: one case, forward slashes, one space between words. */
function plain(text: unknown): string {
  return typeof text === "string" ? text.replace(/\\/g, "/").replace(/\s+/g, " ").toLowerCase() : "";
}

/** A character that can belong to a file name, so that a hit inside a longer name is no hit. A dot before a name counts: "my.notes.md" is not "notes.md". */
const NAME_BEFORE = /[a-z0-9_.-]/u;
const NAME_AFTER = /[a-z0-9_-]/u;

/** Whether `text` names `name`, both already plain: the name stands whole, not inside a longer word or file name. */
function names(text: string, name: string): boolean {
  if (name === "") return false;
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1];
    const after = text[at + name.length];
    if ((before === undefined || !NAME_BEFORE.test(before)) && (after === undefined || !NAME_AFTER.test(after))) return true;
  }
  return false;
}

function checksOf(f: Pick<Feature, "acceptance">): string {
  return plain((Array.isArray(f.acceptance) ? f.acceptance : []).join(" "));
}

/**
 * The files among `added` (the files that feature `f` made new in its branch, as git lists them) that belong to a later feature of `m`.
 * Empty for a mission that has no feature checked by reading, and for a feature that is checked by reading itself: for the old way nothing
 * changes. A file belongs to the first later feature that has not started and whose checks name it, in one of two ways:
 *
 * - the check holds the whole path (`docs/NOTES.md`); or
 * - a line of the plan's contract holds the whole path, and the check holds the file's own name (`NOTES.md`). The contract is for the whole plan,
 *   so by itself it says nothing about which feature the file is for.
 *
 * A file that the words of `f` itself name (its title, its story or its checks) is never counted: `f` was asked to make it.
 */
export function laterFeatureFiles(m: Pick<Mission, "features" | "spec">, f: Pick<Feature, "id" | "title" | "story" | "acceptance" | "mode">, added: readonly string[]): AlsoMade[] {
  if (!hasModeFeature(m.features) || isModeFeature(f)) return [];
  const features = Array.isArray(m.features) ? m.features : [];
  const at = features.findIndex((x) => x.id === f.id);
  if (at < 0) return [];
  const later = features.slice(at + 1).filter((x) => x.status === "pending");
  if (later.length === 0) return [];
  const own = plain([f.title, f.story, ...(Array.isArray(f.acceptance) ? f.acceptance : [])].join(" "));
  const contract = plain(m.spec?.uiContract);
  const found: AlsoMade[] = [];
  for (const file of new Set(added.filter((p): p is string => typeof p === "string" && p !== ""))) {
    const whole = plain(file);
    const ownName = whole.slice(whole.lastIndexOf("/") + 1);
    if (names(own, whole) || names(own, ownName)) continue;
    const inContract = names(contract, whole);
    const owner = later.find((g) => {
      const checks = checksOf(g);
      return names(checks, whole) || (inContract && names(checks, ownName));
    });
    if (owner) found.push({ file, belongsTo: owner.id });
    if (found.length >= MAX_ALSO_MADE) break;
  }
  return found;
}

/** The sentence for one file, as the report and the look say it. `file` and `title` are cleaned by the caller. */
export function alsoMadeSentence(file: string, title: string): string {
  return `It also made “${file}”, which belongs to the later feature “${title}”.`;
}

/**
 * The sentences for feature `f`, in order: nothing for a feature with no `alsoMade`. A damaged entry, or one whose later feature is no longer
 * in the mission, is left out. The file name and the title are made safe to show on one line.
 */
export function alsoMadeSentences(m: Pick<Mission, "features">, f: Pick<Feature, "alsoMade">): string[] {
  if (!Array.isArray(f.alsoMade)) return [];
  const features = Array.isArray(m.features) ? m.features : [];
  return f.alsoMade.flatMap((a) => {
    if (typeof a?.file !== "string" || typeof a.belongsTo !== "string") return [];
    const later = features.find((x) => x.id === a.belongsTo);
    return later === undefined ? [] : [alsoMadeSentence(shown(a.file, 200), shown(String(later.title), 200))];
  });
}
