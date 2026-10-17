/**
 * The design canvas shows a project's screens: self-contained HTML files under
 * `design/`, listed in `design/canvas.json`. These helpers read that list and
 * lay its frames out in canvas pixels.
 */

import { SCREEN_PREVIEW_TILE_HEIGHT, screenPreviewOverviewScale } from "@t3tools/shared/htmlRender";

export const DESIGN_DIRECTORY = "design";
export const DESIGN_MANIFEST_PATH = `${DESIGN_DIRECTORY}/canvas.json`;
export const DESIGN_SCREENS_DIRECTORY = `${DESIGN_DIRECTORY}/screens`;

export const DEFAULT_FRAME_WIDTH = 1440;
export const DEFAULT_FRAME_HEIGHT = 900;
export const UNLISTED_SECTION_TITLE = "Not on the canvas yet";

export interface DesignFrame {
  /** Relative to `design/`, optionally with a `#hash` variant. */
  readonly file: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  /** The screen scrolls inside its frame instead of being clipped. */
  readonly scroll: boolean;
}

export interface DesignSection {
  readonly title: string | null;
  readonly frames: ReadonlyArray<DesignFrame>;
}

export interface DesignPage {
  readonly name: string;
  readonly sections: ReadonlyArray<DesignSection>;
  /** Positions fixed by the canvas file itself (Claude Design canvases). */
  readonly placed?: DesignLayout;
}

export interface DesignCanvas {
  readonly title: string | null;
  readonly pages: ReadonlyArray<DesignPage>;
  /** Page to open first, when the canvas names one. */
  readonly initialPage?: number;
}

export type DesignManifestResult =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid"; readonly message: string }
  | { readonly _tag: "Valid"; readonly canvas: DesignCanvas };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const readSize = (value: unknown, fallback: number): number => {
  const size = typeof value === "number" ? value : Number(value);
  return Number.isFinite(size) && size >= 40 ? Math.min(Math.round(size), 20_000) : fallback;
};

/** A screen path the viewer can serve: inside `design/`, no dot segments. */
export function normalizeScreenFile(file: string): string | null {
  const [path = "", ...hash] = file.trim().replace(/^\.\//, "").split("#");
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment.startsWith(".")) ||
    !/\.html?$/i.test(path)
  ) {
    return null;
  }
  return hash.length > 0 ? `${path}#${hash.join("#")}` : path;
}

export function screenTitleFromFile(file: string): string {
  const name = file.split("#", 1)[0]!.split("/").pop() ?? file;
  const base = name.replace(/\.html?$/i, "").replace(/[-_]+/g, " ");
  return base.length > 0 ? base[0]!.toUpperCase() + base.slice(1) : file;
}

function readFrame(value: unknown): DesignFrame | null {
  if (!isRecord(value)) return null;
  const rawFile = readString(value.file);
  const file = rawFile === null ? null : normalizeScreenFile(rawFile);
  if (file === null) return null;
  return {
    file,
    title: readString(value.title) ?? screenTitleFromFile(file),
    width: readSize(value.width, DEFAULT_FRAME_WIDTH),
    height: readSize(value.height, DEFAULT_FRAME_HEIGHT),
    scroll: value.scroll === true,
  };
}

function readSection(value: unknown): DesignSection | null {
  if (!isRecord(value) || !Array.isArray(value.frames)) return null;
  return {
    title: readString(value.title),
    frames: value.frames.flatMap((frame) => readFrame(frame) ?? []),
  };
}

function readPage(value: unknown, index: number): DesignPage | null {
  if (!isRecord(value) || !Array.isArray(value.sections)) return null;
  return {
    name: readString(value.name) ?? `Page ${index + 1}`,
    sections: value.sections.flatMap((section) => readSection(section) ?? []),
  };
}

/**
 * Reads `canvas.json`. Accepts `pages`, or a bare `sections` or `frames` list
 * for a one-page canvas. Entries it cannot use are skipped, not fatal, so one
 * bad frame does not blank the canvas.
 */
export function parseDesignManifest(contents: string | null): DesignManifestResult {
  if (contents === null) return { _tag: "Missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    return {
      _tag: "Invalid",
      message: `canvas.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(raw)) return { _tag: "Invalid", message: "canvas.json must be a JSON object." };
  const pages = Array.isArray(raw.pages)
    ? raw.pages.flatMap((page, index) => readPage(page, index) ?? [])
    : Array.isArray(raw.sections)
      ? [readPage({ sections: raw.sections }, 0)!]
      : Array.isArray(raw.frames)
        ? [readPage({ sections: [{ frames: raw.frames }] }, 0)!]
        : [];
  return { _tag: "Valid", canvas: { title: readString(raw.title), pages } };
}

/**
 * Screens in `design/screens/` that no page lists still show, on the first
 * page in their own section, so a screen is never lost to a missed entry.
 */
export function withUnlistedScreens(
  canvas: DesignCanvas,
  screenFiles: ReadonlyArray<string>,
): DesignCanvas {
  const listed = new Set(
    canvas.pages.flatMap((page) =>
      page.sections.flatMap((section) => section.frames.map((frame) => frame.file.split("#")[0])),
    ),
  );
  const unlisted = screenFiles
    .filter((file) => /\.html?$/i.test(file) && !listed.has(file))
    .toSorted((left, right) => left.localeCompare(right))
    .map((file): DesignFrame => ({
      file,
      title: screenTitleFromFile(file),
      width: DEFAULT_FRAME_WIDTH,
      height: DEFAULT_FRAME_HEIGHT,
      scroll: true,
    }));
  if (unlisted.length === 0) return canvas;
  const [first, ...rest] =
    canvas.pages.length > 0 ? canvas.pages : [{ name: "Page 1", sections: [] }];
  return {
    ...canvas,
    pages: [
      {
        ...first!,
        sections: [...first!.sections, { title: UNLISTED_SECTION_TITLE, frames: unlisted }],
      },
      ...rest,
    ],
  };
}

// Layout, in canvas pixels at 100%.
export const FRAME_GAP = 80;
export const ROW_GAP = 260;
export const SECTION_GAP = 260;
export const HEADING_SIZE = 96;
// Frame names keep a fixed on-screen height (26px) down to 12% zoom, so the
// space above a row holds one at that zoom: 26 / 0.12 ≈ 220.
export const HEADING_GAP = 240;
export const MAX_ROW_WIDTH = 6400;

export interface PlacedFrame extends DesignFrame {
  readonly key: string;
  readonly x: number;
  readonly y: number;
}

export interface PlacedHeading {
  readonly key: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
}

export interface DesignLayout {
  readonly frames: ReadonlyArray<PlacedFrame>;
  readonly headings: ReadonlyArray<PlacedHeading>;
  readonly width: number;
  readonly height: number;
}

/** Sections stack top to bottom; a section's frames sit in rows that wrap. */
export function layoutDesignPage(page: DesignPage | undefined): DesignLayout {
  if (page?.placed) return page.placed;
  const frames: PlacedFrame[] = [];
  const headings: PlacedHeading[] = [];
  let y = 0;
  let width = 0;
  (page?.sections ?? []).forEach((section, sectionIndex) => {
    if (section.title !== null) {
      headings.push({ key: `heading:${sectionIndex}`, title: section.title, x: 0, y });
      y += HEADING_SIZE + HEADING_GAP;
    }
    let x = 0;
    let rowHeight = 0;
    section.frames.forEach((frame, frameIndex) => {
      if (x > 0 && x + frame.width > MAX_ROW_WIDTH) {
        x = 0;
        y += rowHeight + ROW_GAP;
        rowHeight = 0;
      }
      frames.push({ ...frame, key: `${sectionIndex}:${frameIndex}:${frame.file}`, x, y });
      width = Math.max(width, x + frame.width);
      x += frame.width + FRAME_GAP;
      rowHeight = Math.max(rowHeight, frame.height);
    });
    y += rowHeight + SECTION_GAP;
  });
  return { frames, headings, width: Math.max(width, 1), height: Math.max(y - SECTION_GAP, 1) };
}

export interface CanvasView {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.03;
export const MAX_ZOOM = 4;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** Zooms by `factor` keeping the canvas point under (cx, cy) in place. */
export function zoomViewAt(view: CanvasView, factor: number, cx: number, cy: number): CanvasView {
  const zoom = clampZoom(view.zoom * factor);
  const worldX = (cx - view.x) / view.zoom;
  const worldY = (cy - view.y) / view.zoom;
  return { zoom, x: cx - worldX * zoom, y: cy - worldY * zoom };
}

/**
 * Fits a canvas rectangle in the viewport, never past 100%: centered across,
 * anchored to the top like a design tool, so spare height falls below.
 */
export function fitViewToRect(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number; readonly top: number },
  padding: number,
): CanvasView {
  const usableHeight = Math.max(1, viewport.height - viewport.top - padding * 2);
  const usableWidth = Math.max(1, viewport.width - padding * 2);
  const widthZoom = Math.min(usableWidth / rect.width, 1);
  // Very tall content (long pages, tall columns of screens) would shrink to a
  // sliver; stay at least half as large as fitting the width, and scroll down.
  const zoom = clampZoom(Math.max(Math.min(widthZoom, usableHeight / rect.height), widthZoom / 2));
  return {
    zoom,
    x: (viewport.width - rect.width * zoom) / 2 - rect.x * zoom,
    y: viewport.top + padding - rect.y * zoom,
  };
}

/** The asset URL for a screen, with the workspace revision so edits reload it. */
export function screenFrameSrc(
  assetUrl: string,
  file: string,
  workspaceMutationId: string | null,
): string {
  const hashAt = file.indexOf("#");
  const hash = hashAt === -1 ? "" : file.slice(hashAt);
  if (workspaceMutationId === null) return `${assetUrl}${hash}`;
  const separator = assetUrl.includes("?") ? "&" : "?";
  return `${assetUrl}${separator}workspace-revision=${encodeURIComponent(workspaceMutationId)}${hash}`;
}

// `design/` as a path segment: at the start, after a separator, or after the
// space, quote or `=` that begins a path in a shell command.
const DESIGN_PATH_PATTERN = /(^|[\s"'=\\/])(design|artifacts)[\\/]/;

interface TurnItemLike {
  readonly id: string;
  readonly runId: string | null;
  readonly type: string;
  readonly status: string;
  readonly fileName?: string | undefined;
  readonly changes?:
    | ReadonlyArray<{ readonly path: string; readonly oldPath?: string | undefined }>
    | undefined;
  /** A command's text; other item types carry unrelated input. */
  readonly input?: unknown;
}

const touchesDesign = (item: TurnItemLike): boolean => {
  if (item.type === "file_change") {
    return (
      DESIGN_PATH_PATTERN.test(item.fileName ?? "") ||
      (item.changes ?? []).some(
        (change) =>
          DESIGN_PATH_PATTERN.test(change.path) || DESIGN_PATH_PATTERN.test(change.oldPath ?? ""),
      )
    );
  }
  // A shell command does not report the paths it touched; one naming the
  // folder (cp, mv, a generator script) may have changed screens.
  return (
    item.type === "command_execution" &&
    typeof item.input === "string" &&
    DESIGN_PATH_PATTERN.test(item.input)
  );
};

/**
 * What the canvas needs from a thread's items: a revision that changes only
 * when design files may have changed (so other edits do not reload every
 * screen), and the runs that changed them (to open the canvas when one ends).
 */
export function designChangesOfItems(items: ReadonlyArray<TurnItemLike>): {
  readonly revision: string | null;
  readonly runIds: ReadonlySet<string>;
} {
  let revision: string | null = null;
  const runIds = new Set<string>();
  for (const item of items) {
    if (item.status === "pending" || item.status === "running" || item.status === "waiting") {
      continue;
    }
    if (!touchesDesign(item)) continue;
    revision = item.id;
    if (item.runId !== null) runIds.add(item.runId);
  }
  return { revision, runIds };
}

/**
 * A canvas made in Claude Design and copied into the project: a folder holding
 * `canvas.json` (version 3) and its `.dc.html` screens. Screens render with the
 * folder's own `support.js` viewer.
 */
export interface ClaudeDesignCanvasSource {
  /** Folder of `canvas.json`, relative to the project. */
  readonly root: string;
  readonly label: string;
}

/** Folders whose `canvas.json` sits next to Claude Design screens. */
export function findClaudeDesignCanvases(
  paths: ReadonlyArray<string>,
): ReadonlyArray<ClaudeDesignCanvasSource> {
  const dirname = (path: string) =>
    path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const screenFolders = new Set(paths.filter((path) => /\.dc\.html$/i.test(path)).map(dirname));
  return paths
    .filter((path) => path === "canvas.json" || path.endsWith("/canvas.json"))
    .map(dirname)
    .filter((root) => root !== DESIGN_DIRECTORY && screenFolders.has(root))
    .map((root) => {
      const segments = root.split("/").filter(Boolean);
      const last = segments.at(-1) ?? "Canvas";
      const label = last === "project" && segments.length > 1 ? segments.at(-2)! : last;
      return { root, label };
    })
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

const readCoordinate = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * Reads a Claude Design `canvas.json`: artboards keyed by file with fixed
 * positions, optional pages, and `title1` notes as section headings. Positions
 * are kept as drawn, shifted so the page starts at the origin.
 */
export function parseClaudeDesignCanvas(contents: string | null): DesignManifestResult {
  if (contents === null) return { _tag: "Missing" };
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    return {
      _tag: "Invalid",
      message: `canvas.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isRecord(raw) || !isRecord(raw.boards)) {
    return { _tag: "Invalid", message: "This canvas.json has no artboards." };
  }
  const boards = raw.boards;
  const pageDefs = (Array.isArray(raw.pages) ? raw.pages : []).flatMap((page) => {
    const id = isRecord(page) ? readString(page.id) : null;
    return id === null ? [] : [{ id, name: (isRecord(page) && readString(page.name)) || id }];
  });
  // Artboards with no page of their own get one at the end, so they do not
  // crowd the first page (a canvas with no pages is all one page).
  const UNPAGED = "\u0000unpaged";
  const hasPages = pageDefs.length > 0;
  pageDefs.push({
    id: UNPAGED,
    name: hasPages ? "Other screens" : (readString(raw.title) ?? "Page 1"),
  });
  const pageOf = (value: Record<string, unknown>) => {
    const page = readString(value.page);
    return pageDefs.some((entry) => entry.id === page) ? page : UNPAGED;
  };
  const order = (Array.isArray(raw.order) ? raw.order : []).filter(
    (file): file is string => typeof file === "string" && file in boards,
  );
  const files = [...order, ...Object.keys(boards).filter((file) => !order.includes(file))];
  const notes = isRecord(raw.notes) ? Object.entries(raw.notes) : [];

  const pages = pageDefs.map((pageDef): DesignPage => {
    const frames = files.flatMap((rawFile): PlacedFrame[] => {
      const board = boards[rawFile];
      const file = normalizeScreenFile(rawFile);
      if (!isRecord(board) || file === null || pageOf(board) !== pageDef.id) return [];
      const x = readCoordinate(board.x);
      const y = readCoordinate(board.y);
      if (x === null || y === null) return [];
      return [
        {
          key: `${pageDef.id}:${file}`,
          file,
          title: readString(board.title) ?? screenTitleFromFile(file.replace(/\.dc\.html$/i, "")),
          width: readSize(board.w, DEFAULT_FRAME_WIDTH),
          height: readSize(board.h, DEFAULT_FRAME_HEIGHT),
          scroll: false,
          x,
          y,
        },
      ];
    });
    const headings = notes.flatMap(([id, note]): PlacedHeading[] => {
      if (!isRecord(note) || note.kind !== "title1" || pageOf(note) !== pageDef.id) return [];
      const title = readString(note.text);
      const x = readCoordinate(note.x);
      const y = readCoordinate(note.y);
      return title === null || x === null || y === null ? [] : [{ key: `note:${id}`, title, x, y }];
    });
    const minX =
      frames.length > 0
        ? Math.min(...frames.map((frame) => frame.x), ...headings.map((h) => h.x))
        : 0;
    const minY =
      frames.length > 0
        ? Math.min(...frames.map((frame) => frame.y), ...headings.map((h) => h.y))
        : 0;
    const placedFrames = frames.map((frame) => ({
      ...frame,
      x: frame.x - minX,
      y: frame.y - minY,
    }));
    const placedHeadings = headings.map((h) => ({ ...h, x: h.x - minX, y: h.y - minY }));
    return {
      name: pageDef.name,
      sections: [{ title: null, frames: placedFrames }],
      placed: {
        frames: placedFrames,
        headings: placedHeadings,
        width: Math.max(1, ...placedFrames.map((frame) => frame.x + frame.width)),
        height: Math.max(
          1,
          ...placedFrames.map((frame) => frame.y + frame.height),
          ...placedHeadings.map((h) => h.y + HEADING_SIZE),
        ),
      },
    };
  });
  const shown = pages.filter((page) => page.sections[0]!.frames.length > 0);
  const launchPage = isRecord(raw.launch) ? readString(raw.launch.page) : null;
  const launchName = pageDefs.find((entry) => entry.id === launchPage)?.name;
  const initialPage = shown.findIndex((page) => page.name === launchName);
  return {
    _tag: "Valid",
    canvas: {
      title: readString(raw.title),
      pages: shown,
      ...(initialPage > 0 ? { initialPage } : {}),
    },
  };
}

/** Most screens running as live pages at once; the rest show as placeholders. */
export const MAX_LIVE_FRAMES = 40;
/** Below this on-screen width a screen is too small to read, so it stays a placeholder. */
export const MIN_LIVE_FRAME_WIDTH = 48;
/**
 * A screen with a preview image runs live only near its own size: further out
 * the image looks the same and costs nothing to move.
 */
export const MIN_LIVE_SCALE_WITH_PREVIEW = 0.6;
/** Live pages started per step, so a zoom never starts dozens of loads at once. */
export const MAX_NEW_LIVE_FRAMES = 4;

/** The on-screen width at which `frame` starts running as a live page. */
export function liveFrameMinWidth(frame: PlacedFrame, hasPreview: boolean): number {
  return hasPreview ? frame.width * MIN_LIVE_SCALE_WITH_PREVIEW : MIN_LIVE_FRAME_WIDTH;
}

/**
 * The next live set on the way to `target`: frames leave at once, and at most
 * `MAX_NEW_LIVE_FRAMES` join, nearest first as `target` is ordered.
 */
export function stepLiveFrames(
  current: ReadonlySet<string>,
  target: ReadonlySet<string>,
): { readonly next: ReadonlySet<string>; readonly done: boolean } {
  const next = new Set([...current].filter((key) => target.has(key)));
  let added = 0;
  for (const key of target) {
    if (next.has(key)) continue;
    if (added === MAX_NEW_LIVE_FRAMES) return { next, done: false };
    next.add(key);
    added += 1;
  }
  return { next, done: true };
}

/** Sharp preview tiles asked for at once, nearest the center first. */
export const MAX_DETAIL_TILES = 32;

/**
 * Which sharp tiles each screen needs: those of screens shown with more device
 * pixels than their overview image holds, within (or half a panel beyond) the
 * view, nearest the center first.
 */
export function detailTiles(
  frames: ReadonlyArray<PlacedFrame>,
  view: CanvasView,
  viewport: { readonly width: number; readonly height: number },
  devicePixelRatio: number,
): ReadonlyMap<string, ReadonlyArray<number>> {
  const tiles = new Map<string, Array<number>>();
  if (view.zoom <= 0) return tiles;
  const left = -view.x / view.zoom;
  const top = -view.y / view.zoom;
  const width = viewport.width / view.zoom;
  const height = viewport.height / view.zoom;
  const margin = 0.5;
  const candidates: Array<{ key: string; index: number; distance: number }> = [];
  for (const frame of frames) {
    if (view.zoom * devicePixelRatio <= screenPreviewOverviewScale(frame.width, frame.height)) {
      continue;
    }
    if (frame.x + frame.width < left - width * margin || frame.x > left + width * (1 + margin)) {
      continue;
    }
    for (let index = 0; index * SCREEN_PREVIEW_TILE_HEIGHT < frame.height; index++) {
      const tileTop = frame.y + index * SCREEN_PREVIEW_TILE_HEIGHT;
      const tileBottom = Math.min(frame.y + frame.height, tileTop + SCREEN_PREVIEW_TILE_HEIGHT);
      if (tileBottom < top - height * margin || tileTop > top + height * (1 + margin)) continue;
      candidates.push({
        key: frame.key,
        index,
        distance: Math.hypot(
          frame.x + frame.width / 2 - (left + width / 2),
          (tileTop + tileBottom) / 2 - (top + height / 2),
        ),
      });
    }
  }
  for (const { key, index } of candidates
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, MAX_DETAIL_TILES)) {
    const list = tiles.get(key) ?? [];
    list.push(index);
    tiles.set(key, list);
  }
  for (const list of tiles.values()) list.sort((a, b) => a - b);
  return tiles;
}

/**
 * The dot grid's transform: its tile scaled to the zoomed spacing (kept
 * between one and two tiles' worth by doubling or halving) and shifted by the
 * pan, within one tile so a layer of fixed size always covers the panel.
 */
export function gridTransform(view: CanvasView, tile = 24): string {
  let spacing = tile * view.zoom;
  if (!(spacing > 0) || !Number.isFinite(spacing)) spacing = tile;
  while (spacing < tile / 2) spacing *= 2;
  while (spacing >= tile) spacing /= 2;
  const offset = (value: number) => (((value % spacing) + spacing) % spacing) - spacing;
  return `translate(${offset(view.x)}px, ${offset(view.y)}px) scale(${spacing / tile})`;
}

/** The image URL for a screen, or one sharp tile of it, from the screen's asset URL. */
export function screenThumbnailSrc(
  assetUrl: string,
  frame: { readonly file: string; readonly width: number; readonly height: number },
  workspaceMutationId: string | null,
  tile: number | null = null,
): string {
  const hashAt = frame.file.indexOf("#");
  const params = new URLSearchParams({
    thumbnail: "",
    w: String(Math.round(frame.width)),
    h: String(Math.round(frame.height)),
  });
  if (tile !== null) params.set("tile", String(tile));
  if (hashAt !== -1) params.set("fragment", frame.file.slice(hashAt + 1));
  if (workspaceMutationId !== null) params.set("workspace-revision", workspaceMutationId);
  return `${assetUrl}${assetUrl.includes("?") ? "&" : "?"}${params.toString()}`;
}

/**
 * Which frames run as live pages for this view: those on screen (with a
 * margin, so panning reveals loaded screens) and big enough to see, nearest
 * the center first, up to `MAX_LIVE_FRAMES`. Frames already live stay live a
 * little further out, so small pans do not reload them.
 */
export function liveFrameKeys(
  frames: ReadonlyArray<PlacedFrame>,
  view: CanvasView,
  viewport: { readonly width: number; readonly height: number },
  previous: ReadonlySet<string>,
  pinned: string | null,
  minWidth: (frame: PlacedFrame) => number = () => MIN_LIVE_FRAME_WIDTH,
  limit = MAX_LIVE_FRAMES,
): ReadonlySet<string> {
  if (view.zoom <= 0) return new Set(pinned ? [pinned] : []);
  const left = -view.x / view.zoom;
  const top = -view.y / view.zoom;
  const width = viewport.width / view.zoom;
  const height = viewport.height / view.zoom;
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const within = (frame: PlacedFrame, margin: number) =>
    frame.x + frame.width >= left - width * margin &&
    frame.x <= left + width * (1 + margin) &&
    frame.y + frame.height >= top - height * margin &&
    frame.y <= top + height * (1 + margin);
  const candidates = frames
    .filter(
      (frame) =>
        frame.width * view.zoom >= minWidth(frame) &&
        within(frame, previous.has(frame.key) ? 1 : 0.5),
    )
    .map((frame) => ({
      key: frame.key,
      distance: Math.hypot(
        frame.x + frame.width / 2 - centerX,
        frame.y + frame.height / 2 - centerY,
      ),
    }))
    .toSorted((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.key);
  // The screen in use comes first, so it is never the one left waiting.
  return new Set(pinned ? [pinned, ...candidates] : candidates);
}

export const frameDirectory = (file: string) => {
  const path = file.split("#", 1)[0]!;
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
};

/** The asset URL for `file`, from one issued for a file in the same folder. */
export function siblingAssetUrl(url: string, file: string): string {
  const name = file.split("#", 1)[0]!.split("/").pop() ?? "";
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${encodeURIComponent(name)}${query === -1 ? "" : url.slice(query)}`;
}
