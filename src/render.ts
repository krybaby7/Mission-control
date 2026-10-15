// Pictures of web pages: the page as it first loads, at phone width and at desktop width (docs/modes-spec.md section 7).
//
// The real renderer uses `playwright-core` (pinned 1.64.0), imported with `import()` inside `playwrightRenderer`, so a
// missing package degrades to "no pictures" and not to a crash. The browser context is offline, service workers are
// blocked, and a route lets a `file://` request through only when its real path (symbolic links followed) is inside the
// worktree (spec 7.2). Facts are read with `page.evaluate` given a STRING, because tsconfig has no DOM types.
//
// What was tried: web requests, a beacon and a WebSocket are blocked or fail (spec 2.5, 2.7); a symbolic link inside the
// folder that points outside it is blocked by the real-path test (spec 2.7). Not tried: a service worker, DNS lookups,
// WebRTC, a redirect by a meta tag.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plainName } from "./checks.js";
import { slugify } from "./state.js";
import type { PictureWhy } from "./types.js";

/** The two widths pictures are taken at: 390 by 844 and 1280 by 800 (spec 7.2). */
export type PictureWidth = "phone" | "desktop";

/** What the browser reported about one page at one width (spec 7.2, "Facts"). They feed rules S23 to S26 and the quote check. */
export interface PageFacts {
  title: string;
  /** Whether the page has a viewport line. */
  hasViewport: boolean;
  /** `document.documentElement.scrollWidth` and `window.innerWidth`. At phone width, a document wider than the window scrolls sideways. */
  documentWidth: number;
  windowWidth: number;
  /** The visible text. Kept in memory for S08, S09 and the quote check; never written to disk. */
  text: string;
  /** The text of the visible headings (`h1` to `h6`), at most 200. Kept in memory for S08 on a drawn page. Absent from a renderer that does not read them. */
  headings?: string[];
  /** How many pictures on the page did not load. */
  brokenImages: number;
  /** Requests for the project's own files that failed (paths relative to the worktree; each cleaned with plainName). */
  failedRequests: string[];
  /** The first three errors the page raised while loading, each cut at 100 characters. */
  errors: string[];
}

/** One picture of one page at one width. */
export interface PageShot {
  width: PictureWidth;
  /** Absolute path of the PNG in the mission's `screenshots` folder, named by `pictureName`. */
  file: string;
  facts: PageFacts;
}

/** One page: drawn at both widths, or not drawn and why. */
export interface RenderedPage {
  /** Repo-relative path of the page, as git reports it. */
  path: string;
  /** The page's place in the sorted list, 1 to 4 (the `<n>` of the picture name). */
  n: number;
  /** Both pictures, when the page was drawn. */
  phone?: PageShot;
  desktop?: PageShot;
  /** Set when the page was not drawn (or only partly). */
  why?: PictureWhy;
}

/** What one call to `Renderer.render` asks for. Every `path` has already passed the reading rules of spec 6.1. */
export interface RenderRequest {
  /** Absolute path of the feature's worktree: the only place a page may load files from. */
  worktree: string;
  /** The folder the PNG files go in: `<mission folder>/screenshots`. */
  outDir: string;
  featureId: string;
  /** The pages to draw, at most 4, in sorted order, with their `n` from 1. */
  pages: { path: string; n: number }[];
}

/** The answer of a render. Never throws: a failure is a `why`. */
export interface RenderResult {
  pages: RenderedPage[];
  /** How many PNG files were written (two for a page drawn at both widths). */
  taken: number;
  /** Set when nothing could be drawn at all: the tool, the browser or the start failed, or (with `taken` 0) the reason of the first page that was not drawn. */
  why?: PictureWhy;
}

/** Tests inject a fake. */
export interface Renderer {
  render(request: RenderRequest): Promise<RenderResult>;
}

// ───────────────────────────── Finding the browser (spec 7.2) ─────────────────────────────

function isFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

/** The folder `<prefix><number>` with the highest number that holds one of the executables, or undefined. */
function newest(base: string, prefix: string, executables: string[]): string | undefined {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return undefined;
  }
  const folders = names
    .map((name) => ({ name, n: name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length)) ? Number(name.slice(prefix.length)) : -1 }))
    .filter((f) => f.n >= 0)
    .sort((a, b) => b.n - a.n);
  for (const folder of folders) {
    for (const rel of executables) {
      const path = join(base, folder.name, rel);
      if (isFile(path)) return path;
    }
  }
  return undefined;
}

/**
 * The path of a Chromium executable, or undefined: first the environment variable `MC_CHROMIUM`; else the newest folder
 * `chromium-<number>` under `PLAYWRIGHT_BROWSERS_PATH` (default `/ms-playwright`) that holds `chrome-linux/chrome` or
 * `chrome-linux64/chrome`; else the newest `chromium_headless_shell-<number>` that holds
 * `chrome-headless-shell-linux64/chrome-headless-shell`. Looked up by folder, not by the library's version (spec 7.2).
 */
export function findChromium(env: Record<string, string | undefined> = process.env): string | undefined {
  const explicit = env.MC_CHROMIUM;
  if (explicit !== undefined && explicit !== "" && isFile(explicit)) return explicit;
  const base = env.PLAYWRIGHT_BROWSERS_PATH !== undefined && env.PLAYWRIGHT_BROWSERS_PATH !== "" ? env.PLAYWRIGHT_BROWSERS_PATH : "/ms-playwright";
  return (
    newest(base, "chromium-", ["chrome-linux/chrome", "chrome-linux64/chrome"]) ??
    // The second name is the older layout of the same program.
    newest(base, "chromium_headless_shell-", ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell"])
  );
}

// ───────────────────────────── Drawing ─────────────────────────────

const SIZES: Record<PictureWidth, { width: number; height: number }> = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};
const PAGE_LOAD_MS = 20_000;
const RENDER_TOTAL_MS = 60_000;
const SETTLE_MS = 300;
const MAX_PICTURE_HEIGHT = 4000;
const MAX_TEXT = 200_000;

/** Read with `page.evaluate` as a STRING: tsconfig has no DOM types, so a function that names `document` would not compile. */
const FACTS_SCRIPT = `(() => {
  const body = document.body;
  const text = body ? body.innerText : "";
  const visible = (e) => { try { return e.checkVisibility ? e.checkVisibility() : e.offsetParent !== null; } catch (x) { return false; } };
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(visible).slice(0, 200).map((h) => String(h.innerText || "").slice(0, 200));
  const broken = Array.from(document.images).filter((i) => i.getAttribute("src") && i.complete && i.naturalWidth === 0).length;
  return {
    title: document.title,
    hasViewport: !!document.querySelector('meta[name="viewport" i]'),
    documentWidth: document.documentElement.scrollWidth,
    windowWidth: window.innerWidth,
    scrollHeight: document.documentElement.scrollHeight,
    text: text,
    headings: headings,
    brokenImages: broken,
  };
})()`;

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * The answer of the string `page.evaluate`, checked in plain code: garbage gives empty facts and not a crash. `scrollHeight`
 * is only for cutting the picture; it is not one of the facts.
 */
export function readPageFacts(raw: unknown, failedRequests: string[] = [], errors: string[] = []): { facts: PageFacts; scrollHeight: number } {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const headings = Array.isArray(r.headings) ? r.headings.filter((h): h is string => typeof h === "string").slice(0, 200).map((h) => h.slice(0, 200)) : undefined;
  const facts: PageFacts = {
    title: typeof r.title === "string" ? r.title.slice(0, 300) : "",
    hasViewport: r.hasViewport === true,
    documentWidth: num(r.documentWidth, 0),
    windowWidth: num(r.windowWidth, 0),
    text: typeof r.text === "string" ? r.text.slice(0, MAX_TEXT) : "",
    brokenImages: Math.max(0, Math.floor(num(r.brokenImages, 0))),
    failedRequests,
    errors,
  };
  if (headings !== undefined) facts.headings = headings;
  return { facts, scrollHeight: num(r.scrollHeight, 0) };
}

/** A path from the request: relative, no empty, `.` or `..` part, no NUL. */
function safePagePath(rel: string): boolean {
  if (rel === "" || rel.startsWith("/") || rel.includes("\0")) return false;
  return rel.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

// Just the parts of playwright-core that are used, so the file needs no types from the package or from a DOM.
interface PwRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(code?: string): Promise<void>;
}
interface PwPage {
  on(event: string, handler: (arg: { message?: string } | Error) => void): void;
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(options: { fullPage: boolean; clip: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
}
interface PwContext {
  route(url: string, handler: (route: PwRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwBrowser {
  newContext(options: Record<string, unknown>): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: { launch(options: Record<string, unknown>): Promise<PwBrowser> };
}

type ShotOutcome = { ok: true; shot: PageShot } | { ok: false; why: PictureWhy };

function whyOf(err: unknown): PictureWhy {
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/timeout/i.test(message)) return "too_slow";
  if (/ERR_BLOCKED_BY_CLIENT|blockedbyclient/i.test(message)) return "not_plain_file";
  return "start_failed";
}

async function shoot(browser: PwBrowser, root: string, pageAbs: string, request: RenderRequest, page: { path: string; n: number }, width: PictureWidth, loadMs: number): Promise<ShotOutcome> {
  const size = SIZES[width];
  let context: PwContext | undefined;
  try {
    context = await browser.newContext({ viewport: size, offline: true, serviceWorkers: "block", javaScriptEnabled: true, acceptDownloads: false });
    const failed = new Set<string>();
    const errors: string[] = [];
    // Every request is judged here: only a file whose real path is inside the worktree is let through. A web address,
    // another scheme, a file outside the folder and a symbolic link that points outside it are all aborted.
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      try {
        if (url.startsWith("data:")) {
          await route.continue();
          return;
        }
        if (url.startsWith("file:")) {
          const lexical = fileURLToPath(url);
          try {
            const real = await realpath(lexical);
            if (inside(root, real)) {
              await route.continue();
              return;
            }
            // A link inside the folder that points outside it: the project's own file, which the page cannot load.
            if (inside(root, lexical) && failed.size < 50) failed.add(plainName(lexical.slice(root.length + 1).split(sep).join("/"), 80));
          } catch {
            // A file that does not exist: if it is the project's own, the page could not load it.
            if (inside(root, lexical) && failed.size < 50) failed.add(plainName(lexical.slice(root.length + 1).split(sep).join("/"), 80));
          }
        }
      } catch {
        // A URL that cannot be read as a path is blocked like the others.
      }
      await route.abort("blockedbyclient");
    });
    const tab = await context.newPage();
    tab.on("pageerror", (err) => {
      if (errors.length < 3) errors.push(plainName(err instanceof Error ? err.message : String(err.message ?? err), 100));
    });
    await tab.goto(pathToFileURL(pageAbs).href, { waitUntil: "load", timeout: loadMs });
    await tab.waitForTimeout(SETTLE_MS);
    const { facts, scrollHeight } = readPageFacts(await tab.evaluate(FACTS_SCRIPT), [...failed], errors);
    const height = Math.min(Math.max(Math.floor(scrollHeight), size.height), MAX_PICTURE_HEIGHT);
    const png = await tab.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: size.width, height } });
    mkdirSync(request.outDir, { recursive: true });
    const file = join(request.outDir, pictureName(request.featureId, page.n, page.path, width));
    // Never write through a link that is already there.
    await unlink(file).catch(() => undefined);
    await writeFile(file, png, { flag: "wx" });
    return { ok: true, shot: { width, file, facts } };
  } catch (err) {
    return { ok: false, why: whyOf(err) };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

/** The real renderer. `env` and `pageLoadMs` (how long a page may take to load, default 20 seconds) are only for tests. */
export function playwrightRenderer(options: { env?: Record<string, string | undefined>; pageLoadMs?: number } = {}): Renderer {
  const env = options.env ?? process.env;
  const loadMs = options.pageLoadMs ?? PAGE_LOAD_MS;
  return {
    async render(request: RenderRequest): Promise<RenderResult> {
      if (request.pages.length === 0) return { pages: [], taken: 0 };
      let pw: PwModule;
      try {
        const loaded = (await import("playwright-core")) as unknown as PwModule & { default?: PwModule };
        pw = loaded.chromium !== undefined ? loaded : (loaded.default as PwModule);
        if (pw?.chromium === undefined) throw new Error("no chromium");
      } catch {
        return { pages: [], taken: 0, why: "no_tool" };
      }
      const executablePath = findChromium(env);
      if (executablePath === undefined) return { pages: [], taken: 0, why: "no_browser" };
      let root: string;
      try {
        root = await realpath(request.worktree);
      } catch {
        return { pages: [], taken: 0, why: "start_failed" };
      }
      let browser: PwBrowser;
      try {
        // The second switch keeps the browser from running out of the small shared memory a container gives it by default. The third
        // lets no name or address be looked up: a page that sends the browser to a web address (a script, a form, a link, a refresh
        // tag) made it open a connection to that address before the request was aborted. Pages and files of the project need no lookup.
        browser = await pw.chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage", "--host-resolver-rules=MAP * ~NOTFOUND"], timeout: PAGE_LOAD_MS });
      } catch {
        return { pages: [], taken: 0, why: "start_failed" };
      }
      const started = Date.now();
      const pages: RenderedPage[] = [];
      let taken = 0;
      try {
        for (const page of request.pages) {
          const result: RenderedPage = { path: page.path, n: page.n };
          pages.push(result);
          if (Date.now() - started > RENDER_TOTAL_MS) {
            result.why = "too_slow";
            continue;
          }
          // The page itself must be a plain file inside the folder: not a link, not a path that leaves it.
          let abs: string | undefined;
          try {
            if (safePagePath(page.path)) {
              const candidate = join(root, ...page.path.split("/"));
              const st = await lstat(candidate);
              if (st.isFile() && !st.isSymbolicLink() && inside(root, await realpath(candidate))) abs = candidate;
            }
          } catch {
            abs = undefined;
          }
          if (abs === undefined) {
            result.why = "not_plain_file";
            continue;
          }
          for (const width of ["phone", "desktop"] as const) {
            if (Date.now() - started > RENDER_TOTAL_MS) {
              result.why = "too_slow";
              break;
            }
            const outcome = await shoot(browser, root, abs, request, page, width, loadMs);
            if (outcome.ok) {
              result[width] = outcome.shot;
              taken++;
            } else {
              result.why = outcome.why;
              if (outcome.why === "too_slow") break;
            }
          }
        }
      } finally {
        await browser.close().catch(() => undefined);
      }
      const answer: RenderResult = { pages, taken };
      if (taken === 0 && pages.length > 0) {
        const why = pages.find((p) => p.why !== undefined)?.why;
        if (why !== undefined) answer.why = why;
      }
      return answer;
    },
  };
}

// ───────────────────────────── Names ─────────────────────────────

const SLUG_MAX = 40;

/** A feature id as it goes into a file name: lowercase letters, digits and single dashes (what ids are), else slugged. */
function idPart(featureId: string): string {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(featureId) ? featureId : slugify(featureId, 60);
}

/**
 * `slugify` of a path without its extension, at most 40 characters. When the slug had to be cut, or the name held anything
 * but plain ASCII (so that it slugs to the same few words as another name), a short hash of the whole name ends it, so two
 * different names do not get the same picture name even at the same place in the list.
 */
function pageSlug(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const withoutExt = dot > 0 ? path.slice(0, path.length - (base.length - dot)) : path;
  const slug = slugify(withoutExt, 200);
  const plain = /^[A-Za-z0-9._/ -]*$/.test(withoutExt);
  if (slug.length <= SLUG_MAX && plain) return slug;
  const hash = createHash("sha1").update(withoutExt).digest("hex").slice(0, 6);
  return `${slug.slice(0, SLUG_MAX - 7).replace(/-+$/, "")}-${hash}`;
}

function place(n: number): number {
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * The file name (no folder) of one picture of a page: `look__<feature id>__<n>__<page>__<phone|desktop>.png`, where
 * `<page>` is `slugify` of the page path without its extension, at most 40 characters. A double underscore cannot occur
 * in a feature id or a slug, so no two pages get the same name (spec 7.2).
 */
export function pictureName(featureId: string, n: number, pagePath: string, width: PictureWidth): string {
  return `look__${idPart(featureId)}__${place(n)}__${pageSlug(pagePath)}__${width}.png`;
}

/**
 * The file name of the copy of a changed raster image for the owner: `look__<feature id>__image<n>__<slug of the name><extension>`,
 * `n` counting from 1 in sorted order (spec 7.1, item c).
 */
export function imageName(featureId: string, n: number, imagePath: string): string {
  const base = imagePath.slice(imagePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 && /^\.(?:png|jpg|jpeg|gif|webp)$/i.test(base.slice(dot)) ? base.slice(dot).toLowerCase() : "";
  return `look__${idPart(featureId)}__image${place(n)}__${pageSlug(imagePath)}${ext}`;
}
