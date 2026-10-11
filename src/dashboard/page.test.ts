// Tests for locating and reading the dashboard page (docs/dashboard-spec.md, 2.4 and 15: T-SRV page parts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageRoot } from "../prompts.js";
import { loadPage, PAGE_FILE } from "./page.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-page-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadPage", () => {
  it("reads dashboard/index.html under the given root, exactly as it is", () => {
    mkdirSync(join(root, "dashboard"));
    const html = '<!doctype html>\r\n<title>Mission Control</title>\n<p>ä “quoted” ✓</p>\n';
    writeFileSync(join(root, "dashboard", "index.html"), html);
    expect(loadPage(root)).toBe(html);
  });

  it("looks for the file at the package root, next to prompts/ and stacks/", () => {
    expect(PAGE_FILE).toBe(join("dashboard", "index.html"));
    expect(join(packageRoot(), PAGE_FILE)).toBe(join(packageRoot(), "dashboard", "index.html"));
  });

  it("says in plain words what to do when the file is missing", () => {
    expect(() => loadPage(root)).toThrow("The dashboard page file is missing (dashboard/index.html). Rebuild the image: mc build.");
    mkdirSync(join(root, "dashboard"));
    expect(() => loadPage(root)).toThrow("is missing");
  });

  it("says it cannot be read when the path is not a file", () => {
    mkdirSync(join(root, "dashboard", "index.html"), { recursive: true });
    expect(() => loadPage(root)).toThrow("The dashboard page file (dashboard/index.html) cannot be read.");
  });
});
