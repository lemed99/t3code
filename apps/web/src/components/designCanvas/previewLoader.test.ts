import { describe, expect, it } from "vite-plus/test";

import { PREVIEW_PRIORITY, PreviewLoader } from "./previewLoader";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(concurrency: number) {
  const started: Array<string> = [];
  const aborted: Array<string> = [];
  const pending = new Map<string, () => void>();
  const loader = new PreviewLoader(concurrency, (url, signal) => {
    started.push(url);
    return new Promise<Blob>((resolve, reject) => {
      pending.set(url, () => resolve(new Blob([url])));
      signal.addEventListener("abort", () => {
        aborted.push(url);
        reject(new Error("aborted"));
      });
    });
  });
  return { loader, started, aborted, finish: (url: string) => pending.get(url)?.() };
}

describe("PreviewLoader", () => {
  it("downloads screens in view first, newest first, and overviews before tiles", async () => {
    const { loader, started, finish } = harness(1);
    loader.load("far", PREVIEW_PRIORITY.far, () => {});
    loader.load("tile", PREVIEW_PRIORITY.tile, () => {});
    loader.load("near-old", PREVIEW_PRIORITY.near, () => {});
    loader.load("near-new", PREVIEW_PRIORITY.near, () => {});
    // The first request started before the rest arrived.
    expect(started).toEqual(["far"]);
    for (const url of ["far", "near-new", "near-old"]) {
      finish(url);
      await settle();
    }
    expect(started).toEqual(["far", "near-new", "near-old", "tile"]);
  });

  it("cancels a download no screen wants any more, but not one asked for again", async () => {
    const { loader, aborted } = harness(2);
    const dropA = loader.load("a", PREVIEW_PRIORITY.far, () => {});
    const dropB = loader.load("b", PREVIEW_PRIORITY.far, () => {});
    dropA();
    dropB();
    loader.load("b", PREVIEW_PRIORITY.near, () => {});
    await settle();
    expect(aborted).toEqual(["a"]);
  });

  it("hands every listener the image, and later ones the stored result", async () => {
    const { loader, started, finish } = harness(2);
    const results: Array<string | null> = [];
    loader.load("a", PREVIEW_PRIORITY.near, (image) => results.push(image));
    loader.load("a", PREVIEW_PRIORITY.far, (image) => results.push(image));
    finish("a");
    await settle();
    loader.load("a", PREVIEW_PRIORITY.near, (image) => results.push(image));
    expect(started).toEqual(["a"]);
    expect(results).toHaveLength(3);
    expect(results.every((image) => image !== null && image === results[0])).toBe(true);
  });

  it("stops everything when cleared", async () => {
    const { loader, aborted } = harness(1);
    loader.load("a", PREVIEW_PRIORITY.near, () => {});
    loader.load("b", PREVIEW_PRIORITY.near, () => {});
    loader.clear();
    await settle();
    expect(aborted).toEqual(["a"]);
  });
});
