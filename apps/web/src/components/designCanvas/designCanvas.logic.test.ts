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
  fitViewToRect,
  layoutDesignPage,
  normalizeScreenFile,
  parseDesignManifest,
  screenFrameSrc,
  wheelZoomFactor,
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

  it("caps a wheel zoom step", () => {
    expect(wheelZoomFactor(-1000)).toBeCloseTo(Math.exp(0.3));
    expect(wheelZoomFactor(4)).toBeCloseTo(Math.exp(-0.024));
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
