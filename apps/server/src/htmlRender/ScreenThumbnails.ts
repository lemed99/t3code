// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as RcRef from "effect/RcRef";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import { SCREEN_PREVIEW_TILE_HEIGHT, screenPreviewOverviewScale } from "@t3tools/shared/htmlRender";

import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import * as HeadlessChrome from "./headlessChrome.ts";

// Bump to drop every cached image after a change to how screens are captured.
const CACHE_VERSION = 2;
// Captures are mostly the browser laying out and painting, which uses one core each.
const MAX_CONCURRENT_CAPTURES = Math.max(
  2,
  Math.min(6, Math.floor(NodeOS.availableParallelism() / 2)),
);
const BROWSER_IDLE_TIME = "30 seconds";
const MAX_WIDTH = 4_096;
const MAX_HEIGHT = 32_768;
// Two image pixels per CSS pixel: sharp on a Retina display at the screen's own size.
const DETAIL_PIXEL_WIDTH = 2_880;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.Array(
      Schema.Struct({ path: Schema.String, mtimeMs: Schema.Number, size: Schema.Number }),
    ),
    /** The images this render left in the cache, by name. */
    images: Schema.Array(Schema.String),
  }),
);
const decodeManifest = Schema.decodeUnknownOption(Manifest);
const encodeManifest = Schema.encodeSync(Manifest);
type Dependency = (typeof Manifest.Type)["dependencies"][number];

/** The whole screen at half scale, or one sharp tile of it. */
export type ScreenThumbnailImage =
  | { readonly _tag: "Overview" }
  | { readonly _tag: "Tile"; readonly index: number };

export interface ScreenThumbnailRequest {
  /** The screen's absolute path, which the cache is keyed by. */
  readonly filePath: string;
  /** The screen's URL path within its served folder, with any `#fragment`. */
  readonly pagePath: string;
  readonly width: number;
  readonly height: number;
  readonly image: ScreenThumbnailImage;
  /** Made ahead of need: waits until no screen someone is looking at is waiting. */
  readonly background?: boolean;
  /** Resolves a path of the served folder to a file the screen may load. */
  readonly resolveFile: (relativePath: string) => Effect.Effect<string | null>;
}

export type ScreenThumbnail =
  | { readonly _tag: "Image"; readonly bytes: Uint8Array }
  /** The headless browser is not installed yet, or could not render the screen. */
  | { readonly _tag: "Unavailable" };

export class ScreenThumbnails extends Context.Service<
  ScreenThumbnails,
  {
    readonly thumbnail: (input: ScreenThumbnailRequest) => Effect.Effect<ScreenThumbnail>;
  }
>()("t3/htmlRender/ScreenThumbnails") {}

const clamp = (value: number, max: number) => Math.max(1, Math.min(max, Math.round(value)));

export const overviewScale = screenPreviewOverviewScale;

/** Image pixels per CSS pixel of a tile. */
export const detailScale = (width: number) => Math.max(1, Math.min(2, DETAIL_PIXEL_WIDTH / width));

export const tileCount = (height: number) => Math.ceil(height / SCREEN_PREVIEW_TILE_HEIGHT);

const imageName = (image: ScreenThumbnailImage) =>
  image._tag === "Overview" ? "overview" : `tile-${image.index}`;

const unavailable: ScreenThumbnail = { _tag: "Unavailable" };
const image = (bytes: Uint8Array | null): ScreenThumbnail =>
  bytes === null ? unavailable : { _tag: "Image", bytes };

const sameDependencies = (a: ReadonlyArray<Dependency>, b: ReadonlyArray<Dependency>) =>
  a.length === b.length &&
  a.every((dependency) =>
    b.some(
      (other) =>
        other.path === dependency.path &&
        other.mtimeMs === dependency.mtimeMs &&
        other.size === dependency.size,
    ),
  );

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const noSandbox = PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment);
  const cacheDirectory = path.join(config.providerStatusCacheDir, "screen-thumbnails");
  const captures = yield* Semaphore.make(MAX_CONCURRENT_CAPTURES);
  // Background captures run one at a time, and only while no foreground one
  // is waiting or running.
  const backgroundLane = yield* Semaphore.make(1);
  let foreground = 0;
  let foregroundDone: Deferred.Deferred<void> | null = null;
  const capturing = <A, E, R>(background: boolean, effect: Effect.Effect<A, E, R>) =>
    background
      ? Effect.gen(function* () {
          while (foreground > 0) {
            foregroundDone ??= Deferred.makeUnsafe<void>();
            yield* Deferred.await(foregroundDone);
          }
          return yield* backgroundLane.withPermits(1)(captures.withPermits(1)(effect));
        })
      : Effect.acquireUseRelease(
          Effect.sync(() => void foreground++),
          () => captures.withPermits(1)(effect),
          () =>
            Effect.suspend(() => {
              foreground -= 1;
              if (foreground > 0 || foregroundDone === null) return Effect.void;
              const done = foregroundDone;
              foregroundDone = null;
              return Deferred.succeed(done, undefined);
            }),
        );
  const inFlight = new Map<string, Deferred.Deferred<void>>();

  // One browser serves every capture and closes once no capture has needed it for a while.
  const browser = yield* RcRef.make({
    acquire: Effect.gen(function* () {
      const executable = yield* previewBrowser.installed;
      if (Option.isNone(executable)) {
        return yield* new HeadlessChrome.HtmlRenderBrowserError({ reason: "not installed" });
      }
      return yield* HeadlessChrome.launchScreenBrowser({
        executable: executable.value,
        noSandbox,
      }).pipe(Effect.provideContext(services));
    }),
    idleTimeToLive: BROWSER_IDLE_TIME,
  });

  const fileStamp = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info): Dependency => ({
        path: filePath,
        mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        size: Number(info.size),
      })),
      Effect.option,
    );

  const manifestPath = (key: string) => path.join(cacheDirectory, `${key}.json`);
  const imagePath = (key: string, name: string) => path.join(cacheDirectory, `${key}.${name}.webp`);

  /** The manifest, if no file the screen loaded has changed since it was written. */
  const currentManifest = (key: string) =>
    Effect.gen(function* () {
      const manifest = yield* fileSystem
        .readFileString(manifestPath(key))
        .pipe(Effect.map(decodeManifest), Effect.orElseSucceed(Option.none));
      if (Option.isNone(manifest)) return null;
      for (const dependency of manifest.value.dependencies) {
        const stamp = yield* fileStamp(dependency.path);
        if (
          Option.isNone(stamp) ||
          stamp.value.mtimeMs !== dependency.mtimeMs ||
          stamp.value.size !== dependency.size
        ) {
          return null;
        }
      }
      return manifest.value;
    });

  const cached = (key: string, name: string) =>
    Effect.gen(function* () {
      const manifest = yield* currentManifest(key);
      if (manifest === null || !manifest.images.includes(name)) return null;
      return yield* fileSystem
        .readFile(imagePath(key, name))
        .pipe(Effect.orElseSucceed(() => null));
    });

  const store = (
    key: string,
    images: ReadonlyArray<readonly [string, Uint8Array]>,
    loaded: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const stamps = yield* Effect.forEach(loaded, fileStamp);
      const dependencies = stamps.flatMap((stamp) => (Option.isSome(stamp) ? [stamp.value] : []));
      // Images an earlier render made from the same files stay valid alongside these.
      const previous = yield* currentManifest(key);
      const kept =
        previous !== null && sameDependencies(previous.dependencies, dependencies)
          ? previous.images
          : [];
      yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
      // Temporary names first, so a reader never sees half an image; the
      // manifest goes last, since it is what makes the images count as current.
      for (const [name, bytes] of images) {
        const temporary = path.join(cacheDirectory, `${key}.${NodeCrypto.randomUUID()}.tmp`);
        yield* fileSystem.writeFile(temporary, bytes);
        yield* fileSystem.rename(temporary, imagePath(key, name));
      }
      yield* fileSystem.writeFileString(
        manifestPath(key),
        encodeManifest({
          dependencies,
          images: [...new Set([...kept, ...images.map(([name]) => name)])],
        }),
      );
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("A screen thumbnail could not be cached.", { cause }),
      ),
      Effect.ignore,
    );

  /**
   * Loads the screen once and captures its overview, plus every tile when
   * `tiles` is set: tiles are only needed once someone zooms in.
   */
  const render = (input: ScreenThumbnailRequest, key: string, tiles: boolean) =>
    Effect.gen(function* () {
      const width = clamp(input.width, MAX_WIDTH);
      const height = clamp(input.height, MAX_HEIGHT);
      const served = new Set<string>([input.filePath]);
      const serve = (relativePath: string) =>
        input.resolveFile(relativePath).pipe(
          Effect.flatMap((filePath) => {
            if (filePath === null) return Effect.succeed(null);
            const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
            if (contentType === undefined) return Effect.succeed(null);
            served.add(filePath);
            return fileSystem.readFile(filePath).pipe(
              Effect.map((bytes) => ({ bytes, contentType })),
              Effect.orElseSucceed(() => null),
            );
          }),
        );
      const names = ["overview"];
      const regions: Array<HeadlessChrome.ScreenRegion> = [
        { y: 0, height, scale: overviewScale(width, height) },
      ];
      if (tiles) {
        for (let index = 0; index < tileCount(height); index++) {
          const y = index * SCREEN_PREVIEW_TILE_HEIGHT;
          names.push(`tile-${index}`);
          regions.push({
            y,
            height: Math.min(SCREEN_PREVIEW_TILE_HEIGHT, height - y),
            scale: detailScale(width),
          });
        }
      }
      const images = yield* capturing(
        input.background === true,
        Effect.scoped(
          RcRef.get(browser).pipe(
            Effect.flatMap((handle) =>
              HeadlessChrome.captureScreen(handle, {
                path: input.pagePath,
                width,
                height,
                regions,
                serve,
              }),
            ),
          ),
        ),
      );
      yield* store(
        key,
        images.map((bytes, index) => [names[index]!, bytes] as const),
        [...served],
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("A screen thumbnail could not be rendered.", {
          filePath: input.filePath,
          cause,
        }),
      ),
    );

  const thumbnail = (input: ScreenThumbnailRequest) =>
    Effect.gen(function* () {
      const key = NodeCrypto.createHash("sha256")
        .update(
          [CACHE_VERSION, input.filePath, input.pagePath, input.width, input.height].join("\0"),
        )
        .digest("hex");
      const name = imageName(input.image);
      const hit = yield* cached(key, name);
      if (hit !== null) return image(hit);

      // The first canvas opened after installing T3 Code fetches the browser;
      // screens show placeholders until it is ready.
      if (Option.isNone(yield* previewBrowser.installed)) {
        yield* previewBrowser.executable.pipe(Effect.ignore, Effect.forkDetach);
        return unavailable;
      }

      // Every request for this screen waits on one render of the kind it needs.
      const tiles = input.image._tag === "Tile";
      const flight = `${key}:${tiles ? "tiles" : "overview"}`;
      const pending = inFlight.get(flight) ?? (tiles ? undefined : inFlight.get(`${key}:tiles`));
      if (pending !== undefined) {
        yield* Deferred.await(pending);
        const rendered = yield* cached(key, name);
        if (rendered !== null) return image(rendered);
      }
      const done = yield* Deferred.make<void>();
      inFlight.set(flight, done);
      yield* render(input, key, tiles).pipe(
        Effect.ensuring(
          Effect.sync(() => inFlight.delete(flight)).pipe(
            Effect.andThen(Deferred.succeed(done, undefined)),
          ),
        ),
      );
      return image(yield* cached(key, name));
    });

  return ScreenThumbnails.of({ thumbnail });
});

export const layer = Layer.effect(ScreenThumbnails, make);
