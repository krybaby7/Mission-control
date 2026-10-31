// Tests of the pictures (docs/modes-spec.md section 7 and the matching tests of section 15). The one real render uses the
// local Chromium only, and is skipped when no browser exists.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { packageRoot } from "./prompts.js";
import { findChromium, imageName, pictureName, playwrightRenderer, readPageFacts, type RenderRequest, type Renderer, type RenderResult } from "./render.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-render-")));
  roots.push(dir);
  return dir;
}

function put(dir: string, rel: string, content: string | Buffer = "x"): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

// ───────────────────────────── A fake satisfies the interface ─────────────────────────────

describe("Renderer", () => {
  it("can be replaced by a fake", async () => {
    const calls: RenderRequest[] = [];
    const fake: Renderer = {
      async render(request): Promise<RenderResult> {
        calls.push(request);
        return { pages: request.pages.map((p) => ({ path: p.path, n: p.n, why: "no_browser" as const })), taken: 0, why: "no_browser" };
      },
    };
    const out = await fake.render({ worktree: "/w", outDir: "/o", featureId: "f", pages: [{ path: "index.html", n: 1 }] });
    expect(out).toEqual({ pages: [{ path: "index.html", n: 1, why: "no_browser" }], taken: 0, why: "no_browser" });
    expect(calls).toHaveLength(1);
  });
});

// ───────────────────────────── findChromium ─────────────────────────────

describe("findChromium", () => {
  it("takes MC_CHROMIUM first when it names a file", () => {
    const dir = temp();
    const explicit = put(dir, "mine/chrome");
    put(dir, "browsers/chromium-1300/chrome-linux/chrome");
    expect(findChromium({ MC_CHROMIUM: explicit, PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers") })).toBe(explicit);
  });

  it("follows a link named by MC_CHROMIUM, as /opt/pw-browsers/chromium is one", () => {
    const dir = temp();
    const real = put(dir, "real/chrome");
    const link = join(dir, "chromium");
    symlinkSync(real, link);
    expect(findChromium({ MC_CHROMIUM: link, PLAYWRIGHT_BROWSERS_PATH: join(dir, "none") })).toBe(link);
  });

  it("ignores MC_CHROMIUM when it names nothing, and looks in the browsers folder", () => {
    const dir = temp();
    const found = put(dir, "browsers/chromium-1200/chrome-linux/chrome");
    expect(findChromium({ MC_CHROMIUM: join(dir, "missing"), PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers") })).toBe(found);
    expect(findChromium({ MC_CHROMIUM: "", PLAYWRIGHT_BROWSERS_PATH: join(dir, "browsers") })).toBe(found);
  });

  it("takes the newest chromium-<number> folder, by number and not by name", () => {
    const dir = temp();
    put(dir, "b/chromium-999/chrome-linux/chrome");
    const newest = put(dir, "b/chromium-1248/chrome-linux/chrome");
    put(dir, "b/chromium-1100/chrome-linux/chrome");
    put(dir, "b/chromium-x/chrome-linux/chrome");
    put(dir, "b/chromium_headless_shell-9999/chrome-headless-shell-linux64/chrome-headless-shell");
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "b") })).toBe(newest);
  });

  it("knows the chrome-linux64 layout", () => {
    const dir = temp();
    const found = put(dir, "b/chromium-1248/chrome-linux64/chrome");
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "b") })).toBe(found);
  });

  it("skips a newer folder that holds no executable and uses an older one that does", () => {
    const dir = temp();
    mkdirSync(join(dir, "b", "chromium-2000"), { recursive: true });
    const older = put(dir, "b/chromium-1000/chrome-linux/chrome");
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "b") })).toBe(older);
  });

  it("falls back to the newest headless shell at the name of the base image", () => {
    const dir = temp();
    put(dir, "b/chromium_headless_shell-1000/chrome-headless-shell-linux64/chrome-headless-shell");
    const newest = put(dir, "b/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell");
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "b") })).toBe(newest);
  });

  it("returns nothing when there is nothing", () => {
    const dir = temp();
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "nothing-here") })).toBeUndefined();
    mkdirSync(join(dir, "empty"));
    expect(findChromium({ PLAYWRIGHT_BROWSERS_PATH: join(dir, "empty") })).toBeUndefined();
  });
});

// ───────────────────────────── Names ─────────────────────────────

describe("pictureName", () => {
  it("is look__<feature>__<n>__<page>__<width>.png", () => {
    expect(pictureName("setup-guide", 1, "docs/index.html", "phone")).toBe("look__setup-guide__1__docs-index__phone.png");
    expect(pictureName("landing-page", 4, "Index.HTM", "desktop")).toBe("look__landing-page__4__index__desktop.png");
  });

  it("gives different names to the pairs that collided in the first draft", () => {
    const names = [
      pictureName("a-b", 1, "c.html", "phone"),
      pictureName("a", 1, "b-c.html", "phone"),
      // Two pages that share their first 40 characters, even at the same place in the list.
      pictureName("f", 1, `${"x".repeat(60)}-one.html`, "phone"),
      pictureName("f", 1, `${"x".repeat(60)}-two.html`, "phone"),
      // Two names with no ASCII letter in them.
      pictureName("f", 1, "страница.html", "phone"),
      pictureName("f", 1, "页面.html", "phone"),
      pictureName("f", 1, "mission.html", "phone"),
      pictureName("f", 1, "docs/a.html", "phone"),
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the pattern for every name: lowercase letters, digits and single dashes, 40 characters for the page", () => {
    const hostile = ["../../etc/passwd", "a b.html", "x\ny.html", "ü.html", "", "....", "A".repeat(500) + ".html", "a__b.html", "a--b.html"];
    for (const page of hostile) {
      for (const width of ["phone", "desktop"] as const) {
        const name = pictureName("my-feature", 2, page, width);
        const parts = name.split("__");
        expect(parts, name).toHaveLength(5);
        expect(parts[0]).toBe("look");
        expect(parts[1]).toBe("my-feature");
        expect(parts[2]).toBe("2");
        expect(parts[3]!, name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(parts[3]!.length).toBeLessThanOrEqual(40);
        expect(parts[4]).toBe(`${width}.png`);
      }
    }
  });

  it("slugs a feature id that is not what ids are, so a slash cannot reach a file name", () => {
    const name = pictureName("../x/Y z", 1, "a.html", "phone");
    expect(name).not.toContain("/");
    expect(name.split("__")).toHaveLength(5);
  });

  it("names the copy of an image for the owner", () => {
    expect(imageName("f", 1, "img/cat.PNG")).toBe("look__f__image1__img-cat.png");
    expect(imageName("f", 2, "photos/a.jpeg")).toBe("look__f__image2__photos-a.jpeg");
    expect(imageName("f", 3, "x.webp")).toBe("look__f__image3__x.webp");
    expect(imageName("f", 1, "noext")).toBe("look__f__image1__noext");
    const odd = imageName("f", 1, "../../etc/passwd.png");
    expect(odd).not.toContain("/");
    expect(imageName("a-b", 1, "c.png")).not.toBe(imageName("a", 1, "b-c.png"));
  });
});

// ───────────────────────────── The answer of the string evaluate ─────────────────────────────

describe("readPageFacts", () => {
  it("reads a good answer", () => {
    const { facts, scrollHeight } = readPageFacts(
      { title: "T", hasViewport: true, documentWidth: 900, windowWidth: 390, scrollHeight: 2000, text: "Hello", headings: ["A", "B"], brokenImages: 2 },
      ["x.css"],
      ["boom"],
    );
    expect(facts).toEqual({ title: "T", hasViewport: true, documentWidth: 900, windowWidth: 390, text: "Hello", headings: ["A", "B"], brokenImages: 2, failedRequests: ["x.css"], errors: ["boom"] });
    expect(scrollHeight).toBe(2000);
  });

  it("gives empty facts for garbage and does not throw", () => {
    const garbage: unknown[] = [undefined, null, 5, "text", [], [1, 2], { title: 5, hasViewport: "yes", documentWidth: "wide", windowWidth: NaN, text: {}, headings: "h", brokenImages: -3 }, { headings: [1, null, "ok"] }];
    for (const g of garbage) {
      const { facts, scrollHeight } = readPageFacts(g);
      expect(facts.title).toBe(typeof (g as { title?: unknown } | undefined)?.title === "string" ? (g as { title: string }).title : "");
      expect(facts.hasViewport).toBe(false);
      expect(facts.documentWidth).toBe(0);
      expect(facts.windowWidth).toBe(0);
      expect(facts.text).toBe("");
      expect(facts.brokenImages).toBe(0);
      expect(facts.failedRequests).toEqual([]);
      expect(facts.errors).toEqual([]);
      expect(scrollHeight).toBe(0);
    }
    expect(readPageFacts({ headings: [1, null, "ok"] }).facts.headings).toEqual(["ok"]);
    expect(readPageFacts({ headings: "h" }).facts.headings).toBeUndefined();
  });

  it("cuts a huge text and long headings", () => {
    const { facts } = readPageFacts({ text: "x".repeat(1_000_000), headings: ["h".repeat(1000)] });
    expect(facts.text.length).toBe(200_000);
    expect(facts.headings![0]!.length).toBe(200);
  });
});

// ───────────────────────────── The reasons ─────────────────────────────

describe("playwrightRenderer, when nothing can be drawn", () => {
  const request = (dir: string): RenderRequest => ({ worktree: dir, outDir: join(dir, "out"), featureId: "f", pages: [{ path: "index.html", n: 1 }] });

  it("says no_tool when the picture tool cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("playwright-core", () => {
      throw new Error("Cannot find module 'playwright-core'");
    });
    try {
      const { playwrightRenderer: fresh } = await import("./render.js");
      const dir = temp();
      expect(await fresh({ env: { MC_CHROMIUM: "/opt/pw-browsers/chromium" } }).render(request(dir))).toEqual({ pages: [], taken: 0, why: "no_tool" });
    } finally {
      vi.doUnmock("playwright-core");
      vi.resetModules();
    }
  });

  it("draws nothing, and starts nothing, when there is no page", async () => {
    const dir = temp();
    expect(await playwrightRenderer({ env: {} }).render({ worktree: dir, outDir: join(dir, "out"), featureId: "f", pages: [] })).toEqual({ pages: [], taken: 0 });
  });

  it("says no_browser when no browser is found", async () => {
    const dir = temp();
    const out = await playwrightRenderer({ env: { PLAYWRIGHT_BROWSERS_PATH: join(dir, "none") } }).render(request(dir));
    expect(out).toEqual({ pages: [], taken: 0, why: "no_browser" });
  });

  it("says start_failed when the browser would not start", async () => {
    const dir = temp();
    const fake = put(dir, "fake-chrome", "#!/bin/sh\nexit 1\n");
    chmodSync(fake, 0o755);
    put(dir, "index.html", "<title>t</title>");
    const out = await playwrightRenderer({ env: { MC_CHROMIUM: fake } }).render(request(dir));
    expect(out).toEqual({ pages: [], taken: 0, why: "start_failed" });
  }, 60_000);
});

// ───────────────────────────── One real render ─────────────────────────────

const chromium = process.env.MC_CHROMIUM && existsSync(process.env.MC_CHROMIUM) ? process.env.MC_CHROMIUM : existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
const haveTool = existsSync(join(packageRoot(), "node_modules", "playwright-core", "package.json"));

// A 1 by 1 picture, so that a picture that loads can be told from one that does not.
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function pngSize(file: string): { width: number; height: number; signature: string } {
  const bytes = readFileSync(file);
  return { signature: bytes.subarray(0, 8).toString("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe.skipIf(chromium === undefined || !haveTool)("a real render with the local Chromium", () => {
  const env = { ...process.env, MC_CHROMIUM: chromium };

  it("draws a page at both widths, tells a sideways scroll at phone width, and blocks everything outside the folder", async () => {
    const outside = temp();
    put(outside, "outside.png", PNG_1X1);
    put(outside, "secret.txt", "TOP SECRET OUTSIDE TEXT");
    const dir = temp();
    put(dir, "inside.png", PNG_1X1);
    symlinkSync(join(outside, "outside.png"), join(dir, "linkout.png"));
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    put(
      dir,
      "index.html",
      `<!doctype html><html><head><title>Reading list</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<h1>Hello page</h1><h2 style="display:none">Hidden heading</h2><div style="width:900px;background:#eee">A wide block</div>
<img id="a" src="inside.png" alt="inside">
<img id="b" src="file://${join(outside, "outside.png")}" alt="outside by path">
<img id="c" src="linkout.png" alt="outside by link">
<img id="d" src="https://example.com/a.png" alt="the internet">
<img id="e" src="missing.png" alt="missing">
<iframe src="link.txt" width="300" height="60"></iframe>
<script>fetch("https://example.com/beacon").catch(function () { document.title = "beacon blocked"; });</script>
</body></html>`,
    );
    const outDir = join(temp(), "screenshots");
    const out = await playwrightRenderer({ env }).render({ worktree: dir, outDir, featureId: "landing", pages: [{ path: "index.html", n: 1 }] });
    expect(out.why).toBeUndefined();
    expect(out.taken).toBe(2);
    const page = out.pages[0]!;
    expect(page.why).toBeUndefined();
    const phone = page.phone!;
    const desktop = page.desktop!;
    // The pictures: PNG files, named by pictureName, as wide as the screen.
    expect(phone.file).toBe(join(outDir, pictureName("landing", 1, "index.html", "phone")));
    expect(desktop.file).toBe(join(outDir, pictureName("landing", 1, "index.html", "desktop")));
    expect(pngSize(phone.file)).toMatchObject({ signature: "89504e470d0a1a0a", width: 390 });
    expect(pngSize(desktop.file)).toMatchObject({ signature: "89504e470d0a1a0a", width: 1280 });
    expect(pngSize(phone.file).height).toBeLessThanOrEqual(4000);
    // The facts: the wide block scrolls sideways on a phone and not on a desktop.
    expect(phone.facts.windowWidth).toBe(390);
    expect(phone.facts.documentWidth).toBeGreaterThanOrEqual(900);
    expect(desktop.facts.windowWidth).toBe(1280);
    expect(desktop.facts.documentWidth).toBe(1280);
    expect(phone.facts.hasViewport).toBe(true);
    expect(phone.facts.text).toContain("Hello page");
    expect(phone.facts.text).toContain("A wide block");
    expect(phone.facts.text).not.toContain("Hidden heading");
    expect(phone.facts.headings).toEqual(["Hello page"]);
    // Blocked: a picture by a file path outside the folder, a link inside the folder that points outside, the internet, and
    // a missing file. The picture inside the folder loads.
    expect(phone.facts.brokenImages).toBe(4);
    expect(phone.facts.failedRequests.sort()).toEqual(["link.txt", "linkout.png", "missing.png"]);
    expect(phone.facts.failedRequests.some((f) => f.includes("outside"))).toBe(false);
    expect(readFileSync(phone.file).includes("TOP SECRET")).toBe(false);
    expect(phone.facts.errors).toEqual([]);
  }, 90_000);

  it("does not draw a page that is itself a link, or a path that leaves the folder", async () => {
    const outside = temp();
    put(outside, "page.html", "<title>outside</title><p>OUTSIDE PAGE</p>");
    const dir = temp();
    symlinkSync(join(outside, "page.html"), join(dir, "linked.html"));
    put(dir, "good.html", "<title>good</title><p>Fine</p>");
    const outDir = join(temp(), "screenshots");
    const out = await playwrightRenderer({ env }).render({
      worktree: dir,
      outDir,
      featureId: "f",
      pages: [
        { path: "good.html", n: 1 },
        { path: "linked.html", n: 2 },
        { path: "../escape.html", n: 3 },
        { path: "/etc/hostname", n: 4 },
      ],
    });
    expect(out.taken).toBe(2);
    expect(out.pages.map((p) => [p.path, p.why])).toEqual([
      ["good.html", undefined],
      ["linked.html", "not_plain_file"],
      ["../escape.html", "not_plain_file"],
      ["/etc/hostname", "not_plain_file"],
    ]);
    expect(existsSync(join(outDir, pictureName("f", 2, "linked.html", "phone")))).toBe(false);
  }, 90_000);

  it("does not run a script that is a link to a file outside the folder, and runs one that is inside", async () => {
    const outside = temp();
    put(outside, "leak.js", 'window.leaked = "yes";');
    put(outside, "secret.html", "<title>s</title><p>TOP SECRET OUTSIDE PAGE</p>");
    const dir = temp();
    symlinkSync(join(outside, "leak.js"), join(dir, "leak.js"));
    symlinkSync(join(outside, "secret.html"), join(dir, "inner.html"));
    put(dir, "ok.js", 'window.okLoaded = "yes";');
    put(
      dir,
      "index.html",
      `<title>t</title><meta name="viewport" content="width=device-width"><p>Frame:</p><iframe src="inner.html" width="500" height="200"></iframe><script src="ok.js"></script><script src="leak.js"></script><script>document.body.appendChild(document.createTextNode("okLoaded=" + String(window.okLoaded) + " leaked=" + String(window.leaked)));</script>`,
    );
    const out = await playwrightRenderer({ env }).render({ worktree: dir, outDir: join(temp(), "s"), featureId: "f", pages: [{ path: "index.html", n: 1 }] });
    expect(out.taken).toBe(2);
    const facts = out.pages[0]!.phone!.facts;
    expect(facts.text).toContain("okLoaded=yes leaked=undefined");
    expect(facts.failedRequests.sort()).toEqual(["inner.html", "leak.js"]);
  }, 90_000);

  // V1-7: every web request of a page is aborted, but a page that navigates to a web address (a script, a form, a link, a refresh tag) used to
  // make the browser open a connection to that address before the request was aborted. A hostile page could use that to knock on an internal
  // host and port. A listener on the loopback address counts the connections; there must be none, and the page itself is still drawn.
  describe("a page that navigates to a web address", () => {
    async function listener(): Promise<{ port: number; connections: () => number; bytes: () => number; close: () => Promise<void> }> {
      const sockets: Socket[] = [];
      let connections = 0;
      let bytes = 0;
      const server = createServer((socket) => {
        connections++;
        sockets.push(socket);
        socket.on("data", (chunk) => (bytes += chunk.length));
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return {
        port,
        connections: () => connections,
        bytes: () => bytes,
        close: () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => resolve());
          }),
      };
    }

    const pages = (url: string): [string, string][] => [
      ["location assigned by a script", `<script>location.href = ${JSON.stringify(url)};</script>`],
      ["a form sent with POST", `<form id="f" method="post" action="${url}"><input name="a" value="b"></form><script>document.getElementById("f").submit();</script>`],
      ["a form sent with GET", `<form id="f" method="get" action="${url}"><input name="a" value="b"></form><script>document.getElementById("f").submit();</script>`],
      ["a link that is clicked", `<a id="l" href="${url}">go</a><script>document.getElementById("l").click();</script>`],
      ["a refresh tag", `<meta http-equiv="refresh" content="0;url=${url}">`],
      ["a window that is opened", `<script>window.open(${JSON.stringify(url)});</script>`],
      ["a frame", `<iframe src="${url}"></iframe>`],
      ["an image", `<img src="${url}x.png">`],
    ];

    it.each(pages("http://127.0.0.1:0/").map(([label]) => label))("opens no connection for %s, and still draws the page at both widths", async (label) => {
      const server = await listener();
      try {
        const body = pages(`http://127.0.0.1:${server.port}/`).find(([name]) => name === label)![1];
        const dir = temp();
        put(dir, "index.html", `<!doctype html><title>t</title><meta name="viewport" content="width=device-width"><h1>Still drawn</h1>${body}`);
        const out = await playwrightRenderer({ env }).render({ worktree: dir, outDir: join(temp(), "s"), featureId: "f", pages: [{ path: "index.html", n: 1 }] });
        // Whatever the page did, nothing reached the listener (and the browser had every chance: it was given seconds to do it).
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(server.connections(), `${label}: connections`).toBe(0);
        expect(server.bytes()).toBe(0);
        // A page that leaves for a web address cannot be drawn as it was meant; one that only tries is still drawn at both widths.
        if (out.taken > 0) expect(out.taken).toBe(2);
      } finally {
        await server.close();
      }
    }, 90_000);

    it("draws a page of the project with a link to another page of the project at both widths", async () => {
      const dir = temp();
      put(dir, "other.html", "<!doctype html><title>o</title><p>The other page</p>");
      put(dir, "style.css", "h1 { color: rgb(1, 2, 3); }");
      put(dir, "index.html", '<!doctype html><title>t</title><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="style.css"><h1>Home</h1><a href="other.html">other</a><iframe src="other.html"></iframe>');
      const out = await playwrightRenderer({ env }).render({ worktree: dir, outDir: join(temp(), "s"), featureId: "f", pages: [{ path: "index.html", n: 1 }] });
      expect(out.taken).toBe(2);
      expect(out.pages[0]!.phone!.facts.text).toContain("Home");
      expect(out.pages[0]!.phone!.facts.failedRequests).toEqual([]);
      expect(out.pages[0]!.desktop!.facts.text).toContain("Home");
    }, 90_000);
  });

  it("gives up on a page that never finishes loading, with the reason too_slow", async () => {
    const dir = temp();
    put(dir, "loop.html", "<title>t</title><script>while (true) {}</script>");
    const out = await playwrightRenderer({ env, pageLoadMs: 1500 }).render({ worktree: dir, outDir: join(temp(), "s"), featureId: "f", pages: [{ path: "loop.html", n: 1 }] });
    expect(out.taken).toBe(0);
    expect(out.pages[0]!.why).toBe("too_slow");
    expect(out.why).toBe("too_slow");
  }, 90_000);
});

describe("browser positive launch policy", () => {
  it("passes a controlled environment to Playwright without provider or injection settings", async () => {
    vi.resetModules();
    let launch: Record<string, unknown> | undefined;
    vi.doMock("playwright-core", () => ({ chromium: { launch: async (options: Record<string, unknown>) => { launch = options; throw new Error("synthetic browser cannot start"); } } }));
    vi.stubEnv("MC_UNRELATED_SECRET", "synthetic-secret");
    vi.stubEnv("NODE_OPTIONS", "--require=/tmp/synthetic-missing");
    vi.stubEnv("CODEX_HOME", "/tmp/synthetic-config");
    try {
      const { playwrightRenderer: fresh } = await import("./render.js");
      const dir = temp();
      const fake = put(dir, "fake-chrome");
      put(dir, "index.html", "<title>fixture</title>");
      const result = await fresh({ env: { MC_CHROMIUM: fake } }).render({ worktree: dir, outDir: join(dir, "out"), featureId: "f", pages: [{ path: "index.html", n: 1 }] });
      expect(result.why).toBe("start_failed");
      expect(launch?.env).toBeDefined();
      const env = launch!.env as Record<string, string>;
      expect(env).not.toHaveProperty("MC_UNRELATED_SECRET");
      expect(env).not.toHaveProperty("NODE_OPTIONS");
      expect(env).not.toHaveProperty("CODEX_HOME");
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(existsSync(env.HOME!)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock("playwright-core");
      vi.resetModules();
    }
  });
});
