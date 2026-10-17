import { describe, expect, it } from "vite-plus/test";

import {
  FRAME_GAP,
  HEADING_GAP,
  HEADING_SIZE,
  MAX_ROW_WIDTH,
  ROW_GAP,
  SECTION_GAP,
  UNLISTED_SECTION_TITLE,
  designChangesOfItems,
  detailTiles,
  gridTransform,
  findClaudeDesignCanvases,
  fitViewToRect,
  layoutDesignPage,
  liveFrameKeys,
  liveFrameMinWidth,
  MAX_LIVE_FRAMES,
  MAX_NEW_LIVE_FRAMES,
  normalizeScreenFile,
  parseClaudeDesignCanvas,
  parseDesignManifest,
  screenFrameSrc,
  screenThumbnailSrc,
  stepLiveFrames,
  withUnlistedScreens,
  zoomViewAt,
} from "./designCanvas.logic";

describe("parseDesignManifest", () => {
  it("reads pages, sections and frames, with defaults", () => {
    const result = parseDesignManifest(
      JSON.stringify({
        title: "Venna",
        pages: [
          {
            name: "Flows",
            sections: [
              {
                title: "Onboarding",
                frames: [
                  { file: "screens/welcome.html", title: "Welcome", width: 390, height: 844 },
                  { file: "./screens/topics.html" },
                ],
              },
            ],
          },
          { sections: [] },
        ],
      }),
    );
    expect(result).toEqual({
      _tag: "Valid",
      canvas: {
        title: "Venna",
        pages: [
          {
            name: "Flows",
            sections: [
              {
                title: "Onboarding",
                frames: [
                  {
                    file: "screens/welcome.html",
                    title: "Welcome",
                    width: 390,
                    height: 844,
                    scroll: false,
                  },
                  {
                    file: "screens/topics.html",
                    title: "Topics",
                    width: 1440,
                    height: 900,
                    scroll: false,
                  },
                ],
              },
            ],
          },
          { name: "Page 2", sections: [] },
        ],
      },
    });
  });

  it("accepts a bare frames list and skips frames it cannot serve", () => {
    const result = parseDesignManifest(
      JSON.stringify({
        frames: [
          { file: "screens/a.html#dark", width: "390", height: 10 },
          { file: "../secrets.html" },
          { file: "screens/.hidden/b.html" },
          { file: "screens/data.json" },
          { title: "no file" },
        ],
      }),
    );
    expect(result._tag === "Valid" && result.canvas.pages[0]?.sections[0]?.frames).toEqual([
      { file: "screens/a.html#dark", title: "A", width: 390, height: 900, scroll: false },
    ]);
  });

  it("reports missing and malformed manifests", () => {
    expect(parseDesignManifest(null)).toEqual({ _tag: "Missing" });
    expect(parseDesignManifest("{ nope")._tag).toBe("Invalid");
    expect(parseDesignManifest("[]")).toEqual({
      _tag: "Invalid",
      message: "canvas.json must be a JSON object.",
    });
  });
});

describe("normalizeScreenFile", () => {
  it("keeps paths the viewer can serve", () => {
    expect(normalizeScreenFile("screens/home.html")).toBe("screens/home.html");
    expect(normalizeScreenFile("./home.htm#v2")).toBe("home.htm#v2");
    expect(normalizeScreenFile("/abs/home.html")).toBeNull();
    expect(normalizeScreenFile("screens//home.html")).toBeNull();
    expect(normalizeScreenFile("screens/home.png")).toBeNull();
  });
});

describe("withUnlistedScreens", () => {
  it("adds screens no page lists to the first page", () => {
    const parsed = parseDesignManifest(
      JSON.stringify({ frames: [{ file: "screens/home.html#dark" }] }),
    );
    const canvas = parsed._tag === "Valid" ? parsed.canvas : null;
    const merged = withUnlistedScreens(canvas!, [
      "screens/home.html",
      "screens/settings-billing.html",
      "screens/logo.png",
    ]);
    expect(merged.pages[0]?.sections.at(-1)).toEqual({
      title: UNLISTED_SECTION_TITLE,
      frames: [
        {
          file: "screens/settings-billing.html",
          title: "Settings billing",
          width: 1440,
          height: 900,
          scroll: true,
        },
      ],
    });
  });

  it("makes a page for screens when there is no manifest", () => {
    const merged = withUnlistedScreens({ title: null, pages: [] }, ["screens/home.html"]);
    expect(merged.pages).toHaveLength(1);
    expect(merged.pages[0]?.name).toBe("Page 1");
  });
});

describe("layoutDesignPage", () => {
  it("stacks sections and wraps long rows", () => {
    const frame = (file: string, width: number, height: number) => ({
      file,
      title: file,
      width,
      height,
      scroll: false,
    });
    const layout = layoutDesignPage({
      name: "Page 1",
      sections: [
        {
          title: "Web",
          frames: [
            frame("a.html", 3000, 900),
            frame("b.html", 3000, 900),
            frame("c.html", 1440, 800),
          ],
        },
        { title: null, frames: [frame("d.html", 390, 844)] },
      ],
    });
    const top = HEADING_SIZE + HEADING_GAP;
    expect(layout.headings).toEqual([{ key: "heading:0", title: "Web", x: 0, y: 0 }]);
    expect(layout.frames.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: top },
      { x: 3000 + FRAME_GAP, y: top },
      { x: 0, y: top + 900 + ROW_GAP },
      { x: 0, y: top + 900 + ROW_GAP + 800 + SECTION_GAP },
    ]);
    expect(3000 + FRAME_GAP + 3000 + FRAME_GAP + 1440).toBeGreaterThan(MAX_ROW_WIDTH);
    expect(layout.width).toBe(6080);
    expect(layout.height).toBe(top + 900 + ROW_GAP + 800 + SECTION_GAP + 844);
  });
});

describe("canvas view math", () => {
  it("zooms around the pointer", () => {
    const view = zoomViewAt({ x: 0, y: 0, zoom: 1 }, 2, 100, 50);
    expect(view).toEqual({ x: -100, y: -50, zoom: 2 });
    expect(zoomViewAt(view, 100, 0, 0).zoom).toBe(4);
  });

  it("fits a rectangle from the top without passing 100%", () => {
    expect(
      fitViewToRect(
        { x: 0, y: 0, width: 2000, height: 1000 },
        { width: 1040, height: 600, top: 40 },
        20,
      ),
    ).toEqual({ zoom: 0.5, x: 20, y: 60 });
    expect(
      fitViewToRect(
        { x: 0, y: 0, width: 100, height: 100 },
        { width: 1000, height: 1000, top: 0 },
        0,
      ).zoom,
    ).toBe(1);
  });

  it("keeps tall content readable instead of fitting its whole height", () => {
    expect(
      fitViewToRect(
        { x: 0, y: 0, width: 1000, height: 20_000 },
        { width: 1040, height: 600, top: 40 },
        20,
      ).zoom,
    ).toBe(0.5);
  });
});

describe("screenFrameSrc", () => {
  it("adds the revision before any hash", () => {
    expect(screenFrameSrc("/api/assets/t/home.html", "screens/home.html#dark", "r 1")).toBe(
      "/api/assets/t/home.html?workspace-revision=r%201#dark",
    );
    expect(screenFrameSrc("/a?x=1", "home.html", "2")).toBe("/a?x=1&workspace-revision=2");
    expect(screenFrameSrc("/a", "home.html", null)).toBe("/a");
  });
});

describe("designChangesOfItems", () => {
  it("tracks only settled changes to design files", () => {
    const changes = designChangesOfItems([
      { id: "1", runId: "run-a", type: "file_change", status: "completed", fileName: "src/app.ts" },
      {
        id: "2",
        runId: "run-a",
        type: "file_change",
        status: "completed",
        fileName: "/repo/design/screens/home.html",
      },
      {
        id: "3",
        runId: "run-b",
        type: "command_execution",
        status: "completed",
        input: "cp a.html design/screens/",
      },
      { id: "4", runId: "run-c", type: "command_execution", status: "completed", input: "ls" },
      {
        id: "5",
        runId: "run-d",
        type: "file_change",
        status: "running",
        fileName: "design/canvas.json",
      },
      {
        id: "6",
        runId: "run-e",
        type: "tool_call",
        status: "completed",
        input: { path: "design/x" },
      },
    ]);
    expect(changes.revision).toBe("3");
    expect([...changes.runIds]).toEqual(["run-a", "run-b"]);
  });
});

describe("Claude Design canvases", () => {
  it("finds canvas folders next to their screens", () => {
    expect(
      findClaudeDesignCanvases([
        "design/canvas.json",
        "design/screens/a.dc.html",
        "artifacts/venna-website/project/canvas.json",
        "artifacts/venna-website/project/Main.dc.html",
        "notes/canvas.json",
      ]),
    ).toEqual([{ root: "artifacts/venna-website/project", label: "venna-website" }]);
  });

  it("keeps artboard positions per page and shifts them to the origin", () => {
    const result = parseClaudeDesignCanvas(
      JSON.stringify({
        v: 3,
        title: "Venna · Website",
        pages: [
          { id: "site", name: "getvenna.com" },
          { id: "empty", name: "Nothing here" },
        ],
        boards: {
          "Main.dc.html": { x: 0, y: 0, w: 1440, h: 900, page: "site", title: "Home" },
          "Other.dc.html": { x: 1560, y: 0, w: 390, h: 844 },
          "../escape.dc.html": { x: 0, y: 0, w: 10, h: 10 },
        },
        order: ["Other.dc.html", "Main.dc.html"],
        launch: { view: "canvas", page: "site" },
        notes: { top: { kind: "title1", text: "Landing", x: 0, y: -300, page: "site" } },
      }),
    );
    expect(result._tag).toBe("Valid");
    const canvas = result._tag === "Valid" ? result.canvas : null;
    expect(canvas?.title).toBe("Venna · Website");
    // An artboard with no page goes to its own page at the end.
    expect(canvas?.pages.map((page) => page.name)).toEqual(["getvenna.com", "Other screens"]);
    const layout = layoutDesignPage(canvas?.pages[0]);
    expect(layout.headings).toEqual([{ key: "note:top", title: "Landing", x: 0, y: 0 }]);
    expect(layout.frames.map(({ file, title, x, y }) => ({ file, title, x, y }))).toEqual([
      { file: "Main.dc.html", title: "Home", x: 0, y: 300 },
    ]);
    expect(layout.width).toBe(1440);
    expect(layout.height).toBe(1200);
    expect(
      layoutDesignPage(canvas?.pages[1]).frames.map(({ file, x, y }) => ({ file, x, y })),
    ).toEqual([{ file: "Other.dc.html", x: 0, y: 0 }]);
  });

  it("rejects files that are not Claude Design canvases", () => {
    expect(parseClaudeDesignCanvas(JSON.stringify({ pages: [] }))._tag).toBe("Invalid");
  });
});

describe("liveFrameKeys", () => {
  const frame = (key: string, x: number, y: number) => ({
    key,
    file: `${key}.html`,
    title: key,
    width: 400,
    height: 800,
    scroll: false,
    x,
    y,
  });
  const frames = [frame("a", 0, 0), frame("b", 500, 0), frame("far", 20_000, 0)];

  it("runs only on-screen frames that are big enough to see", () => {
    const view = { x: 0, y: 0, zoom: 1 };
    expect(
      [...liveFrameKeys(frames, view, { width: 1000, height: 900 }, new Set(), null)].toSorted(),
    ).toEqual(["a", "b"]);
    // At 5% a 400px screen is 20px wide: placeholders, except the one in use.
    expect([
      ...liveFrameKeys(
        frames,
        { x: 0, y: 0, zoom: 0.05 },
        { width: 1000, height: 900 },
        new Set(),
        "a",
      ),
    ]).toEqual(["a"]);
  });

  it("caps live frames, nearest the center first", () => {
    const many = Array.from({ length: 60 }, (_, index) => frame(`f${index}`, index * 420, 0));
    const live = liveFrameKeys(
      many,
      { x: 0, y: 0, zoom: 0.2 },
      { width: 5000, height: 900 },
      new Set(),
      null,
    );
    expect(live.size).toBe(MAX_LIVE_FRAMES);
    expect(live.has("f0")).toBe(false);
  });

  it("keeps screens with a preview as images until they show near full size", () => {
    const withPreview = (candidate: (typeof frames)[number]) => liveFrameMinWidth(candidate, true);
    const viewport = { width: 1000, height: 900 };
    expect(
      liveFrameKeys(frames, { x: 0, y: 0, zoom: 0.4 }, viewport, new Set(), null, withPreview).size,
    ).toBe(0);
    expect([
      ...liveFrameKeys(frames, { x: 0, y: 0, zoom: 0.7 }, viewport, new Set(), null, withPreview),
    ]).toContain("a");
  });
});

describe("stepLiveFrames", () => {
  it("drops frames at once and starts a few new ones per step, in order", () => {
    const target = new Set(["a", "b", "c", "d", "e", "f"]);
    const first = stepLiveFrames(new Set(["gone", "a"]), target);
    expect([...first.next]).toEqual(["a", "b", "c", "d", "e"]);
    expect(first.next.size - 1).toBe(MAX_NEW_LIVE_FRAMES);
    expect(first.done).toBe(false);
    const second = stepLiveFrames(first.next, target);
    expect(second).toEqual({ next: target, done: true });
  });
});

describe("screenThumbnailSrc", () => {
  it("asks for the screen at its size, per revision, with its fragment", () => {
    expect(
      screenThumbnailSrc(
        "/api/assets/t/Main.dc.html",
        { file: "Main.dc.html#board=2", width: 390, height: 844 },
        "r7",
      ),
    ).toBe(
      "/api/assets/t/Main.dc.html?thumbnail=&w=390&h=844&fragment=board%3D2&workspace-revision=r7",
    );
    expect(
      screenThumbnailSrc("/a/b.html?x=1", { file: "b.html", width: 10.4, height: 20 }, null),
    ).toBe("/a/b.html?x=1&thumbnail=&w=10&h=20");
  });
});

describe("detailTiles", () => {
  const frames = [
    {
      key: "desk",
      file: "d.html",
      title: "d",
      width: 1440,
      height: 7547,
      scroll: false,
      x: 0,
      y: 0,
    },
    {
      key: "far",
      file: "f.html",
      title: "f",
      width: 390,
      height: 844,
      scroll: false,
      x: 50_000,
      y: 0,
    },
  ];
  it("asks only for the tiles in view, once the overview is not enough", () => {
    const viewport = { width: 1000, height: 900 };
    // At 40% on a 1x display the half-scale overview holds every pixel shown.
    expect(detailTiles(frames, { x: 0, y: 0, zoom: 0.4 }, viewport, 1).size).toBe(0);
    // At 150% on a 2x display the view covers y 0-600, 900 with its margin: tile 0 only.
    expect([...detailTiles(frames, { x: 0, y: 0, zoom: 1.5 }, viewport, 2)]).toEqual([
      ["desk", [0]],
    ]);
    // Scrolled to the page's bottom, only its last tiles.
    const bottom = detailTiles(frames, { x: 0, y: -7000 * 1.5, zoom: 1.5 }, viewport, 2);
    expect(bottom.get("desk")).toEqual([6, 7]);
  });
});

describe("gridTransform", () => {
  it("keeps the spacing between half and one tile and the shift within one tile", () => {
    expect(gridTransform({ x: 0, y: 0, zoom: 1 })).toBe("translate(-12px, -12px) scale(0.5)");
    expect(gridTransform({ x: 30, y: -5, zoom: 0.75 })).toBe("translate(-6px, -5px) scale(0.75)");
    expect(gridTransform({ x: 6, y: 0, zoom: 0.125 })).toBe("translate(-6px, -12px) scale(0.5)");
  });
});
