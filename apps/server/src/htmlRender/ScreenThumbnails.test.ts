import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ScreenThumbnails from "./ScreenThumbnails.ts";

const TEST_BROWSER_ENV = "T3CODE_TEST_HEADLESS_SHELL";

const layerThumbnails = (
  executable: string | undefined,
  onInstall: Effect.Effect<void> = Effect.void,
) =>
  ScreenThumbnails.layer.pipe(
    Layer.provide(
      Layer.succeed(
        PreviewBrowser.PreviewBrowser,
        PreviewBrowser.PreviewBrowser.of({
          executable: onInstall.pipe(Effect.andThen(Effect.die("This test installs nothing."))),
          installed: Effect.succeed(Option.fromUndefinedOr(executable)),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-screen-thumbnails-" })),
    Layer.provideMerge(NodeServices.layer),
  );

/** Width and height of a lossy, lossless or extended WebP. */
const webpSize = (bytes: Uint8Array) => {
  const data = Buffer.from(bytes);
  expect(data.toString("latin1", 0, 4)).toBe("RIFF");
  expect(data.toString("latin1", 8, 12)).toBe("WEBP");
  const chunk = data.toString("latin1", 12, 16);
  if (chunk === "VP8 ") {
    return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === "VP8L") {
    const bits = data.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  return [data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1];
};

describe("ScreenThumbnails", () => {
  it("keeps tiles at two pixels per CSS pixel and overviews within image limits", () => {
    expect(ScreenThumbnails.detailScale(390)).toBe(2);
    expect(ScreenThumbnails.detailScale(1440)).toBe(2);
    expect(ScreenThumbnails.detailScale(1920)).toBe(1.5);
    expect(ScreenThumbnails.overviewScale(1440, 7547)).toBe(0.5);
    expect(ScreenThumbnails.overviewScale(390, 32_768)).toBe(0.25);
    expect(ScreenThumbnails.tileCount(7547)).toBe(8);
  });

  it.effect("starts installing the browser and reports no image until it is there", () => {
    let installs = 0;
    return Effect.gen(function* () {
      const thumbnails = yield* ScreenThumbnails.ScreenThumbnails;
      const result = yield* thumbnails.thumbnail({
        filePath: "/nowhere/home.html",
        pagePath: "home.html",
        width: 390,
        height: 844,
        image: { _tag: "Overview" },
        resolveFile: () => Effect.succeed(null),
      });
      expect(result._tag).toBe("Unavailable");
      yield* Effect.yieldNow;
      expect(installs).toBe(1);
    }).pipe(
      Effect.provide(
        layerThumbnails(
          undefined,
          Effect.sync(() => void installs++),
        ),
      ),
    );
  });

  it.effect(
    "renders a screen with its folder's files and reuses the image until one changes",
    (ctx) =>
      Effect.gen(function* () {
        const executable = (yield* HostProcess.Environment)[TEST_BROWSER_ENV];
        if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const folder = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-screen-" });
          const screen = path.join(folder, "screens", "home.html");
          const styles = path.join(folder, "screens", "styles.css");
          yield* fileSystem.makeDirectory(path.dirname(screen), { recursive: true });
          yield* fileSystem.writeFileString(
            screen,
            '<!doctype html><link rel="stylesheet" href="./styles.css"><h1>Home</h1><p style="margin-top:2300px">End</p>',
          );
          yield* fileSystem.writeFileString(styles, "body { background: rgb(200, 30, 40); }");

          const requested: Array<string> = [];
          const request = {
            filePath: screen,
            pagePath: "screens/home.html",
            width: 300,
            height: 2500,
            image: { _tag: "Tile", index: 0 } as ScreenThumbnails.ScreenThumbnailImage,
            resolveFile: (relativePath: string) =>
              Effect.sync(() => {
                requested.push(relativePath);
                const resolved = path.join(folder, relativePath);
                return resolved.startsWith(folder) ? resolved : null;
              }),
          };
          const thumbnails = yield* ScreenThumbnails.ScreenThumbnails;

          const first = yield* thumbnails.thumbnail(request);
          if (first._tag !== "Image") return expect.fail("the screen was not rendered");
          // Tiles are 1024 CSS pixels tall at two image pixels each.
          expect(webpSize(first.bytes)).toEqual([600, 2048]);
          expect(requested).toEqual(
            expect.arrayContaining(["screens/home.html", "screens/styles.css"]),
          );

          requested.length = 0;
          const again = yield* thumbnails.thumbnail(request);
          expect(again).toEqual(first);
          // The same load made the last, shorter tile and the full-height overview.
          const last = yield* thumbnails.thumbnail({
            ...request,
            image: { _tag: "Tile", index: 2 },
          });
          if (last._tag !== "Image") return expect.fail("the last tile was not cached");
          expect(webpSize(last.bytes)).toEqual([600, 904]);
          const overview = yield* thumbnails.thumbnail({ ...request, image: { _tag: "Overview" } });
          if (overview._tag !== "Image") return expect.fail("the overview was not cached");
          expect(webpSize(overview.bytes)).toEqual([150, 1250]);
          expect(requested).toEqual([]);

          // A changed stylesheet changes the screen, though the screen's own file did not.
          yield* fileSystem.writeFileString(styles, "body { background: rgb(20, 200, 40); }  ");
          const changed = yield* thumbnails.thumbnail(request);
          expect(changed._tag).toBe("Image");
          expect(requested).toContain("screens/styles.css");
        }).pipe(Effect.provide(layerThumbnails(executable)));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    30_000,
  );
});
