// Finds and reads the dashboard page, dashboard/index.html at the package root, like prompts/ and stacks/
// (docs/dashboard-spec.md, 2.4). It is read once, when the server starts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../prompts.js";

/** The page file, relative to the package root. */
export const PAGE_FILE = join("dashboard", "index.html");

/** Reads the page. Throws a plain-language error when the file is missing or cannot be read. `root` is for tests. */
export function loadPage(root: string = packageRoot()): string {
  const file = join(root, PAGE_FILE);
  if (!existsSync(file)) throw new Error("The dashboard page file is missing (dashboard/index.html). Rebuild the image: mc build.");
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error("The dashboard page file (dashboard/index.html) cannot be read.");
  }
}
