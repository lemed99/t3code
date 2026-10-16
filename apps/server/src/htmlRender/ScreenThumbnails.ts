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

import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";
import * as HeadlessChrome from "./headlessChrome.ts";

// Bump to drop every cached image after a change to how screens are captured.
const CACHE_VERSION = 1;
const MAX_CONCURRENT_CAPTURES = 3;
const BROWSER_IDLE_TIME = "30 seconds";
const MAX_SIDE = 4_096;
// Sharp at the sizes a canvas shows a screen; a live page takes over closer in.
const TARGET_PIXEL_WIDTH = 1_200;
// Light enough to keep one per screen in memory on a canvas of a hundred screens.
const OVERVIEW_SCALE = 0.5;

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
  }),
);
const decodeManifest = Schema.decodeUnknownOption(Manifest);
const encodeManifest = Schema.encodeSync(Manifest);

/** `overview` is a half-scale image; `detail` is sharp at the screen's own size. */
export type ScreenThumbnailDetail = "overview" | "detail";
const DETAILS = ["overview", "detail"] as const satisfies ReadonlyArray<ScreenThumbnailDetail>;

export interface ScreenThumbnailRequest {
  /** The screen's absolute path, which the cache is keyed by. */
  readonly filePath: string;
  /** The screen's URL path within its served folder, with any `#fragment`. */
  readonly pagePath: string;
  readonly width: number;
  readonly height: number;
  readonly detail: ScreenThumbnailDetail;
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

const clampSide = (value: number) => Math.max(1, Math.min(MAX_SIDE, Math.round(value)));

/**
 * Pixels per CSS pixel of the detail image: a small phone screen gets as many
 * pixels as a wide desktop one.
 */
export const detailScale = (width: number) => Math.max(1, Math.min(2, TARGET_PIXEL_WIDTH / width));

const unavailable: ScreenThumbnail = { _tag: "Unavailable" };
const image = (bytes: Uint8Array | null): ScreenThumbnail =>
  bytes === null ? unavailable : { _tag: "Image", bytes };

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
      Effect.map((info) => ({
        path: filePath,
        mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
        size: Number(info.size),
      })),
      Effect.option,
    );

  const imagePath = (key: string, detail: ScreenThumbnailDetail) =>
    path.join(cacheDirectory, `${key}.${detail}.webp`);

  /** The cached image, if no file the screen loaded has changed since. */
  const cached = (key: string, detail: ScreenThumbnailDetail) =>
    Effect.gen(function* () {
      const manifest = yield* fileSystem
        .readFileString(path.join(cacheDirectory, `${key}.json`))
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
      return yield* fileSystem
        .readFile(imagePath(key, detail))
        .pipe(Effect.orElseSucceed(() => null));
    });

  const store = (
    key: string,
    images: ReadonlyArray<Uint8Array>,
    dependencies: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const stamps = yield* Effect.forEach(dependencies, fileStamp);
      const manifest = encodeManifest({
        dependencies: stamps.flatMap((stamp) => (Option.isSome(stamp) ? [stamp.value] : [])),
      });
      yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
      // Temporary names first, so a reader never sees half an image; the
      // manifest goes last, since it is what makes the images count as current.
      for (const [index, detail] of DETAILS.entries()) {
        const bytes = images[index];
        if (bytes === undefined) continue;
        const temporary = path.join(cacheDirectory, `${key}.${NodeCrypto.randomUUID()}.tmp`);
        yield* fileSystem.writeFile(temporary, bytes);
        yield* fileSystem.rename(temporary, imagePath(key, detail));
      }
      yield* fileSystem.writeFileString(path.join(cacheDirectory, `${key}.json`), manifest);
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("A screen thumbnail could not be cached.", { cause }),
      ),
      Effect.ignore,
    );

  /** Captures both images in one load and caches them. */
  const render = (input: ScreenThumbnailRequest, key: string) =>
    Effect.gen(function* () {
      const width = clampSide(input.width);
      const height = clampSide(input.height);
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
      const images = yield* captures.withPermits(1)(
        Effect.scoped(
          RcRef.get(browser).pipe(
            Effect.flatMap((handle) =>
              HeadlessChrome.captureScreen(handle, {
                path: input.pagePath,
                width,
                height,
                scales: DETAILS.map((detail) =>
                  detail === "overview" ? OVERVIEW_SCALE : detailScale(width),
                ),
                serve,
              }),
            ),
          ),
        ),
      );
      yield* store(key, images, [...served]);
      return images[DETAILS.indexOf(input.detail)] ?? null;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("A screen thumbnail could not be rendered.", {
          filePath: input.filePath,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );

  const thumbnail = (input: ScreenThumbnailRequest) =>
    Effect.gen(function* () {
      const key = NodeCrypto.createHash("sha256")
        .update(
          [CACHE_VERSION, input.filePath, input.pagePath, input.width, input.height].join("\0"),
        )
        .digest("hex");
      const hit = yield* cached(key, input.detail);
      if (hit !== null) return image(hit);

      // The first canvas opened after installing T3 Code fetches the browser;
      // screens show placeholders until it is ready.
      if (Option.isNone(yield* previewBrowser.installed)) {
        yield* previewBrowser.executable.pipe(Effect.ignore, Effect.forkDetach);
        return unavailable;
      }

      // Every request for this screen, at either size, waits on one render.
      const pending = inFlight.get(key);
      if (pending !== undefined) {
        yield* Deferred.await(pending);
        return image(yield* cached(key, input.detail));
      }
      const done = yield* Deferred.make<void>();
      inFlight.set(key, done);
      return image(
        yield* render(input, key).pipe(
          Effect.ensuring(
            Effect.sync(() => inFlight.delete(key)).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
            ),
          ),
        ),
      );
    });

  return ScreenThumbnails.of({ thumbnail });
});

export const layer = Layer.effect(ScreenThumbnails, make);
