import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { SCREEN_PREVIEW_TILE_HEIGHT } from "@t3tools/shared/htmlRender";
import {
  FileCode2,
  FileText,
  Globe,
  Maximize,
  Minus,
  Palette,
  Plus,
  SwatchBook,
  Table2,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { DelimitedTablePreview } from "../files/DelimitedTablePreview";
import { workspaceAssetResource } from "../files/filePreviewMode";
import { useProjectEntriesQuery, useProjectFileQuery } from "../files/projectFilesQueryState";
import {
  type CanvasView,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_WIDTH,
  type DesignCanvas,
  HEADING_SIZE,
  type PlacedFrame,
  fitViewToRect,
  layoutDesignPage,
  detailTiles,
  gridTransform,
  liveFrameKeys,
  liveFrameMinWidth,
  parseClaudeDesignCanvas,
  parseDesignManifest,
  screenFrameSrc,
  screenThumbnailSrc,
  screenTitleFromFile,
  stepLiveFrames,
  wheelZoomFactor,
  withUnlistedScreens,
  zoomViewAt,
} from "./designCanvas.logic";
import {
  ARTIFACTS_INDEX_PATH,
  type ProjectArtifact,
  findProjectArtifacts,
  parseArtifactIndex,
} from "./artifacts.logic";
import { ArtifactPageView } from "./ArtifactPageView";
import { PREVIEW_PRIORITY, PreviewLoader, usePreviewImage } from "./previewLoader";
import { DesignSystemView } from "./DesignSystemView";
import {
  ArtifactHeader,
  type ArtifactViewProps,
  type DesignCanvasPanelProps,
  PanelEmpty,
  PanelSpinner,
  ToolbarButton,
} from "./artifactChrome";

/** Room for the floating toolbars above the content when fitting. */
const TOOLBAR_SPACE = 52;
/** Below this zoom frame labels would crowd each other and the headings. */
const LABEL_MIN_ZOOM = 0.12;
/** A screen's preview is retried this often before it is given up on. */
const PREVIEW_RETRIES = 3;
const PREVIEW_RETRY_MS = 15_000;
// Leaves the browser's other connections to this server free for the app.
const PREVIEW_DOWNLOADS = 4;
/** Sharp tiles a screen keeps once asked for, the most recent first. */
const MAX_TILES_PER_SCREEN = 12;
/** Spacing of the dot grid at its densest; it doubles as the zoom halves. */
const GRID_TILE = 24;
/** Between steps that start more live pages. */
const LIVE_STEP_MS = 120;
/** How long a pan or zoom gesture pauses before the canvas catches up on details. */
const GESTURE_SETTLE_MS = 150;

const viewportSize = (viewport: HTMLElement | null) => ({
  width: viewport?.clientWidth ?? 800,
  height: viewport?.clientHeight ?? 600,
});

// Views survive the panel unmounting while another tab is shown.
const savedViews = new Map<string, { page: number; view: CanvasView }>();
// The artifact last shown per project.
const savedSources = new Map<string, string>();

/**
 * The project's design canvas: every screen in `design/` as a frame on a
 * pan-and-zoom board. Screens are self-contained HTML files the agent writes;
 * each runs in a sandboxed frame with an opaque origin, like the file viewer.
 */
/**
 * The project's artifacts, one at a time: designs on a pan-and-zoom canvas
 * (every HTML screen runs in a sandboxed frame with an opaque origin, like the
 * file viewer), documents rendered, sheets as a table.
 */
export default function ArtifactsPanel(props: DesignCanvasPanelProps) {
  const projectEntries = useProjectEntriesQuery(props.environmentId, props.cwd);
  const indexFile = useProjectFileQuery(props.environmentId, props.cwd, ARTIFACTS_INDEX_PATH);
  const artifacts = useMemo(
    () =>
      findProjectArtifacts(
        (projectEntries.data?.entries ?? []).map((entry) => entry.path),
        parseArtifactIndex(indexFile.data?.contents ?? null),
      ),
    [projectEntries.data?.entries, indexFile.data?.contents],
  );
  const projectKey = `${props.environmentId}:${props.cwd}`;
  const [chosenId, setChosenId] = useState<string | null>(
    () => savedSources.get(projectKey) ?? null,
  );
  const choose = useCallback(
    (id: string) => {
      savedSources.set(projectKey, id);
      setChosenId(id);
    },
    [projectKey],
  );
  const selected = artifacts.find((artifact) => artifact.id === chosenId) ?? artifacts[0];

  const refreshEntries = projectEntries.refresh;
  const refreshIndex = indexFile.refresh;
  const refreshList = useCallback(() => {
    refreshEntries();
    refreshIndex();
  }, [refreshEntries, refreshIndex]);
  useWorkspaceMutationRefresh({
    mutationId: props.designRevision,
    refresh: refreshList,
    resourceKey: `${projectKey}:artifacts`,
  });
  // Files changed outside this thread (by hand, or another thread's agent)
  // reload on request: rereads the list and the open artifact.
  const [manualReloads, setManualReloads] = useState(0);
  const revision =
    manualReloads === 0 ? props.designRevision : `${props.designRevision ?? ""}:${manualReloads}`;
  const reload = useCallback(() => {
    refreshList();
    setManualReloads((count) => count + 1);
  }, [refreshList]);
  // Other artifacts' previews are prepared once the open one has had a head start.
  const [prewarming, setPrewarming] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setPrewarming(true), PREWARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!selected) {
    if (projectEntries.isPending) return <PanelSpinner />;
    return (
      <PanelEmpty
        title="No artifacts yet"
        description="Ask the agent for a design, a document or a sheet. Artifacts live in the project's artifacts folder and appear here."
      />
    );
  }
  const picker = <ArtifactPicker artifacts={artifacts} selected={selected} onSelect={choose} />;
  const view = { ...props, designRevision: revision, onReload: reload, picker };
  return (
    <>
      <ArtifactView selected={selected} view={view} />
      {prewarming
        ? artifacts.map((artifact) => (
            <PreviewPrewarm
              key={artifact.id}
              {...props}
              designRevision={revision}
              artifact={artifact}
            />
          ))
        : null}
    </>
  );
}

function ArtifactView(props: {
  readonly selected: ProjectArtifact;
  readonly view: ArtifactViewProps;
}) {
  const { selected, view } = props;
  switch (selected.content._tag) {
    case "ProjectCanvas":
      return <ProjectCanvasView key={selected.id} {...view} root={selected.content.root} />;
    case "ClaudeCanvas":
      return <ClaudeCanvasView key={selected.id} {...view} root={selected.content.root} />;
    case "Screens":
      return (
        <DesignBoard
          key={selected.id}
          {...view}
          root={selected.content.root}
          canvas={screensCanvas(selected.title, selected.content.files)}
          warning={null}
        />
      );
    case "Page":
      return <ArtifactPageView key={selected.id} {...view} path={selected.content.path} />;
    case "DesignSystem":
      return <DesignSystemView key={selected.id} {...view} root={selected.content.root} />;
    case "Document":
      return <ArtifactDocumentView key={selected.id} {...view} path={selected.content.path} />;
    case "Sheet":
      return (
        <ArtifactSheetView
          key={selected.id}
          {...view}
          path={selected.content.path}
          delimiter={selected.content.delimiter}
        />
      );
  }
}

const ARTIFACT_ICONS = {
  design: Palette,
  page: Globe,
  system: SwatchBook,
  doc: FileText,
  sheet: Table2,
} as const;

function ArtifactPicker(props: {
  readonly artifacts: ReadonlyArray<ProjectArtifact>;
  readonly selected: ProjectArtifact;
  readonly onSelect: (id: string) => void;
}) {
  const SelectedIcon = ARTIFACT_ICONS[props.selected.kind];
  return (
    <Select value={props.selected.id} onValueChange={(value) => value && props.onSelect(value)}>
      <SelectTrigger size="sm" variant="ghost" aria-label="Artifact" className="w-auto min-w-0">
        <SelectedIcon className="size-4 shrink-0 text-muted-foreground" />
        <SelectValue>
          <span className="truncate">{props.selected.title}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {props.artifacts.map((artifact) => {
          const Icon = ARTIFACT_ICONS[artifact.kind];
          return (
            <SelectItem key={artifact.id} value={artifact.id}>
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{artifact.title}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

/** HTML screens with no canvas file: one page, side by side, each scrolling. */
function screensCanvas(title: string, files: ReadonlyArray<string>): DesignCanvas {
  return {
    title,
    pages: [
      {
        name: title,
        sections: [
          {
            title: null,
            frames: files.map((file) => ({
              file,
              title: screenTitleFromFile(file),
              width: DEFAULT_FRAME_WIDTH,
              height: DEFAULT_FRAME_HEIGHT,
              scroll: true,
            })),
          },
        ],
      },
    ],
  };
}

type CanvasSourceProps = Pick<
  DesignCanvasPanelProps,
  "environmentId" | "cwd" | "designRevision" | "threadRef" | "draft"
> & { readonly root: string };

/**
 * Asks the server for the previews of every design artifact, every page, in
 * the background, so an artifact opened next finds them made. Screens whose
 * files have not changed come back from the server's cache at once.
 */
function PreviewPrewarm(props: DesignCanvasPanelProps & { readonly artifact: ProjectArtifact }) {
  const content = props.artifact.content;
  switch (content._tag) {
    case "ProjectCanvas":
      return <ProjectCanvasPrewarm {...props} root={content.root} />;
    case "ClaudeCanvas":
      return <ClaudeCanvasPrewarm {...props} root={content.root} />;
    case "Screens":
      return (
        <CanvasPrewarm
          {...props}
          root={content.root}
          canvas={screensCanvas(props.artifact.title, content.files)}
        />
      );
    default:
      return null;
  }
}

function ProjectCanvasPrewarm(props: CanvasSourceProps) {
  const { canvas } = useProjectCanvas(props);
  return <CanvasPrewarm {...props} canvas={canvas} />;
}

function ClaudeCanvasPrewarm(props: CanvasSourceProps) {
  const { parsed } = useClaudeCanvas(props);
  return parsed._tag === "Valid" ? <CanvasPrewarm {...props} canvas={parsed.canvas} /> : null;
}

function CanvasPrewarm(props: CanvasSourceProps & { readonly canvas: DesignCanvas }) {
  const folders = useMemo(() => {
    const byFolder = new Map<string, Array<PlacedFrame>>();
    for (const page of props.canvas.pages) {
      for (const frame of layoutDesignPage(page).frames) {
        const folder = frameDirectory(frame.file);
        byFolder.set(folder, [...(byFolder.get(folder) ?? []), frame]);
      }
    }
    return [...byFolder.values()];
  }, [props.canvas]);
  return folders.map((frames) => (
    <FolderPrewarm key={frameDirectory(frames[0]!.file)} {...props} frames={frames} />
  ));
}

function FolderPrewarm(props: CanvasSourceProps & { readonly frames: ReadonlyArray<PlacedFrame> }) {
  const tokenPath = `${props.root}/${props.frames[0]!.file.split("#", 1)[0]}`;
  const resource = useMemo(
    () =>
      workspaceAssetResource({
        kind: "workspace-file",
        threadRef: props.threadRef,
        draft: props.draft,
        workspaceRoot: props.cwd,
        absolutePath: tokenPath,
      }),
    [props.threadRef, props.draft, props.cwd, tokenPath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const tokenUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  useEffect(() => {
    if (tokenUrl === null) return;
    for (const frame of props.frames) {
      queuePreviewPrewarm(
        `${props.root}/${frame.file}:${frame.width}x${frame.height}:${props.designRevision ?? ""}`,
        `${screenThumbnailSrc(siblingAssetUrl(tokenUrl, frame.file), frame, props.designRevision)}&background`,
      );
    }
  }, [tokenUrl, props.frames, props.root, props.designRevision]);
  return null;
}

// One queue for the whole app: a couple of requests at a time, after a pause,
// so the screens someone is looking at are always fetched first.
const PREWARM_CONCURRENCY = 1;
const PREWARM_DELAY_MS = 3_000;
const prewarmed = new Set<string>();
const prewarmQueue: Array<string> = [];
let prewarmRunning = 0;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let prewarmHeld = false;

function queuePreviewPrewarm(key: string, url: string) {
  if (prewarmed.has(key)) return;
  prewarmed.add(key);
  prewarmQueue.push(url);
  if (!prewarmHeld) prewarmTimer ??= setTimeout(drainPrewarmQueue, PREWARM_DELAY_MS);
}

/**
 * Holds off new captures until the canvas has been still for a while: a
 * capture takes a whole CPU core for a second or two, which a zoom or pan
 * on a smaller machine feels.
 */
function holdPreviewPrewarm(moving: boolean) {
  prewarmHeld = moving;
  if (prewarmTimer !== null) clearTimeout(prewarmTimer);
  prewarmTimer = moving ? null : setTimeout(drainPrewarmQueue, PREWARM_DELAY_MS);
}

function drainPrewarmQueue() {
  prewarmTimer = null;
  startPrewarms();
}

function startPrewarms() {
  if (prewarmHeld || prewarmTimer !== null) return;
  while (prewarmRunning < PREWARM_CONCURRENCY && prewarmQueue.length > 0) {
    const url = prewarmQueue.shift()!;
    prewarmRunning += 1;
    void fetch(url, { priority: "low" })
      .then((response) => response.arrayBuffer())
      .catch(() => undefined)
      .finally(() => {
        prewarmRunning -= 1;
        startPrewarms();
      });
  }
}

/** A canvas agents write in T3 Code: `canvas.json` and `screens/` in `root`. */
function useProjectCanvas(props: CanvasSourceProps) {
  const manifest = useProjectFileQuery(props.environmentId, props.cwd, `${props.root}/canvas.json`);
  const screens = useProjectEntriesQuery(props.environmentId, props.cwd, `${props.root}/screens`);
  const refreshManifest = manifest.refresh;
  const refreshScreens = screens.refresh;
  const refresh = useCallback(() => {
    refreshManifest();
    refreshScreens();
  }, [refreshManifest, refreshScreens]);
  useWorkspaceMutationRefresh({
    mutationId: props.designRevision,
    refresh,
    resourceKey: `${props.environmentId}:${props.cwd}:${props.root}:canvas`,
  });
  const parsed = useMemo(
    () => parseDesignManifest(manifest.data?.contents ?? null),
    [manifest.data?.contents],
  );
  const screenFiles = useMemo(
    () =>
      (screens.data?.entries ?? [])
        .filter((entry) => entry.kind === "file")
        .map((entry) => entry.path.slice(props.root.length + 1)),
    [screens.data?.entries, props.root],
  );
  const canvas = useMemo<DesignCanvas>(
    () =>
      withUnlistedScreens(
        parsed._tag === "Valid" ? parsed.canvas : { title: null, pages: [] },
        screenFiles,
      ),
    [parsed, screenFiles],
  );
  return { canvas, parsed, pending: manifest.isPending || screens.isPending };
}

function ProjectCanvasView(props: ArtifactViewProps & { readonly root: string }) {
  const { canvas, parsed, pending } = useProjectCanvas(props);
  if (!canvas.pages.some((page) => page.sections.some((section) => section.frames.length > 0))) {
    if (pending) return <PanelSpinner />;
    return parsed._tag === "Invalid" ? (
      <PanelEmpty
        title="The canvas can't be read"
        description={`${parsed.message} Ask the agent to fix ${props.root}/canvas.json.`}
      />
    ) : (
      <PanelEmpty
        title="No designs yet"
        description="Ask the agent to design a screen. Screens appear here as the agent makes them."
      />
    );
  }
  return (
    <DesignBoard
      {...props}
      canvas={canvas}
      warning={parsed._tag === "Invalid" ? parsed.message : null}
    />
  );
}

/** A canvas copied from Claude Design: artboards keep their own positions. */
function useClaudeCanvas(props: CanvasSourceProps) {
  const manifest = useProjectFileQuery(props.environmentId, props.cwd, `${props.root}/canvas.json`);
  useWorkspaceMutationRefresh({
    mutationId: props.designRevision,
    refresh: manifest.refresh,
    resourceKey: `${props.environmentId}:${props.cwd}:${props.root}`,
  });
  const parsed = useMemo(
    () => parseClaudeDesignCanvas(manifest.data?.contents ?? null),
    [manifest.data?.contents],
  );
  return { parsed, pending: manifest.isPending };
}

function ClaudeCanvasView(props: ArtifactViewProps & { readonly root: string }) {
  const { parsed, pending } = useClaudeCanvas(props);
  if (parsed._tag !== "Valid" || parsed.canvas.pages.length === 0) {
    if (pending) return <PanelSpinner />;
    return (
      <PanelEmpty
        title="The canvas can't be read"
        description={
          parsed._tag === "Invalid" ? parsed.message : `${props.root}/canvas.json has no artboards.`
        }
      />
    );
  }
  return <DesignBoard {...props} canvas={parsed.canvas} warning={null} />;
}

/** Documents read like a page: the panel scrolls, the toolbar stays on top. */
function ArtifactPage(props: {
  readonly picker: ReactNode;
  readonly path: string;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onReload: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactHeader picker={props.picker} onReload={props.onReload}>
        <ToolbarButton label="Open file" onClick={() => props.onOpenFile(props.path)}>
          <FileCode2 />
        </ToolbarButton>
      </ArtifactHeader>
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </div>
  );
}

function useArtifactFile(props: ArtifactViewProps & { readonly path: string }) {
  const file = useProjectFileQuery(props.environmentId, props.cwd, props.path);
  useWorkspaceMutationRefresh({
    mutationId: props.designRevision,
    refresh: file.refresh,
    resourceKey: `${props.environmentId}:${props.cwd}:${props.path}`,
  });
  return file;
}

function ArtifactDocumentView(props: ArtifactViewProps & { readonly path: string }) {
  const file = useArtifactFile(props);
  return (
    <ArtifactPage {...props}>
      {file.data ? (
        <ChatMarkdown
          text={file.data.contents}
          cwd={props.cwd}
          imageBaseDir={resolvePathLinkTarget(
            props.path.slice(0, props.path.lastIndexOf("/")),
            props.cwd,
          )}
          threadRef={props.threadRef}
          className="artifact-document mx-auto max-w-3xl px-8 pt-12 pb-24"
        />
      ) : file.isPending ? (
        <PanelSpinner />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">Couldn't load {props.path}</p>
      )}
    </ArtifactPage>
  );
}

function ArtifactSheetView(
  props: ArtifactViewProps & { readonly path: string; readonly delimiter: "," | "\t" },
) {
  const file = useArtifactFile(props);
  return (
    <ArtifactPage {...props}>
      {file.data ? (
        <DelimitedTablePreview
          name={props.path}
          text={file.data.contents}
          delimiter={props.delimiter}
        />
      ) : file.isPending ? (
        <PanelSpinner />
      ) : (
        <p className="p-6 text-sm text-muted-foreground">Couldn't load {props.path}</p>
      )}
    </ArtifactPage>
  );
}

function DesignBoard(
  props: DesignCanvasPanelProps & {
    readonly canvas: DesignCanvas;
    /** Folder the canvas's screen paths are relative to. */
    readonly root: string;
    readonly warning: string | null;
    readonly onReload: () => void;
    readonly picker: ReactNode;
  },
) {
  const viewKey = `${props.environmentId}:${props.cwd}:${props.root}`;
  const saved = savedViews.get(viewKey);
  const [pageIndex, setPageIndex] = useState(() =>
    saved && saved.page < props.canvas.pages.length ? saved.page : (props.canvas.initialPage ?? 0),
  );
  const page = props.canvas.pages[Math.min(pageIndex, props.canvas.pages.length - 1)];
  const layout = useMemo(() => layoutDesignPage(page), [page]);
  const tokenFiles = useMemo(() => {
    const files = new Map<string, string>();
    for (const frame of layout.frames) {
      const directory = frameDirectory(frame.file);
      if (!files.has(directory)) files.set(directory, frame.file.split("#", 1)[0]!);
    }
    return files;
  }, [layout.frames]);

  // A board left behind (another artifact or page picked) stops its downloads,
  // so the server captures what is on screen now instead.
  const [previewLoader] = useState(() => new PreviewLoader(PREVIEW_DOWNLOADS));
  useEffect(() => () => previewLoader.clear(), [previewLoader]);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Screens show as preview images, and run as live pages only on screen and
  // near their own size (or, without a preview, once big enough to see).
  const [liveKeys, setLiveKeys] = useState<ReadonlySet<string>>(() => new Set());
  const liveKeysRef = useRef(liveKeys);
  const liveFrameRequest = useRef(0);
  const liveStepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshLiveRef = useRef<() => void>(() => {});
  const previewFailedRef = useRef(new Set<string>());
  const markPreviewFailed = useCallback((key: string) => {
    previewFailedRef.current.add(key);
    refreshLiveRef.current();
  }, []);
  // Screens close enough to show more than their overview image holds.
  // The sharp tiles each screen in view needs, as a comma list per frame key.
  const [tilesByKey, setTilesByKey] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Screens in or near the view, whose previews are fetched first.
  const [nearKeys, setNearKeys] = useState<ReadonlySet<string>>(() => new Set());
  const worldRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const labelLayerRef = useRef<HTMLDivElement>(null);
  const labelZoomRef = useRef<number | null>(null);
  const layoutFramesRef = useRef(layout.frames);
  const labelElementsRef = useRef(new Map<string, HTMLElement>());
  // What fits in each label follows the settled zoom, not every frame's.
  const [labelZoom, setLabelZoom] = useState(saved?.view.zoom ?? 1);
  const viewRef = useRef<CanvasView | null>(saved?.view ?? null);
  // Measured on resize, so gestures never force a layout to read it.
  const viewportSizeRef = useRef(viewportSize(null));
  const zoomReadoutRef = useRef<HTMLSpanElement>(null);
  const [liveKey, setLiveKey] = useState<string | null>(null);
  useEffect(() => {
    refreshLiveRef.current = () => {
      if (liveFrameRequest.current) return;
      liveFrameRequest.current = requestAnimationFrame(() => {
        liveFrameRequest.current = 0;
        const view = viewRef.current;
        if (!view) return;
        const viewport = viewportSizeRef.current;
        const target = liveFrameKeys(
          layout.frames,
          view,
          viewport,
          liveKeysRef.current,
          liveKey,
          (frame) => liveFrameMinWidth(frame, !previewFailedRef.current.has(frame.key)),
        );
        // Pages start a few at a time; the previews cover the rest meanwhile.
        const { next, done } = stepLiveFrames(liveKeysRef.current, target);
        if (liveStepTimer.current !== null) clearTimeout(liveStepTimer.current);
        liveStepTimer.current = done
          ? null
          : setTimeout(() => refreshLiveRef.current(), LIVE_STEP_MS);
        const current = liveKeysRef.current;
        if (next.size !== current.size || [...next].some((key) => !current.has(key))) {
          liveKeysRef.current = next;
          setLiveKeys(next);
        }
        const tiles = new Map(
          [...detailTiles(layout.frames, view, viewport, window.devicePixelRatio)].map(
            ([key, indices]) => [key, indices.join(",")] as const,
          ),
        );
        const near = liveFrameKeys(
          layout.frames,
          view,
          viewport,
          new Set(),
          null,
          () => 0,
          Infinity,
        );
        setNearKeys((previous) =>
          previous.size === near.size && [...near].every((key) => previous.has(key))
            ? previous
            : near,
        );
        setTilesByKey((previous) =>
          previous.size === tiles.size &&
          [...tiles].every(([key, list]) => previous.get(key) === list)
            ? previous
            : tiles,
        );
      });
    };
    refreshLiveRef.current();
  }, [layout.frames, liveKey]);
  useEffect(
    () => () => {
      cancelAnimationFrame(liveFrameRequest.current);
      liveFrameRequest.current = 0;
      if (liveStepTimer.current !== null) clearTimeout(liveStepTimer.current);
    },
    [],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Until the user pans or zooms, the view follows the panel's size: it opens
  // with an animation, so the first measurement is rarely the final one.
  const autoFitRef = useRef(saved === undefined);

  // A gesture changes only transforms and a few variables on small layers, so
  // every frame is composited without restyling the screens. Which screens
  // run live, and which get sharper images, is decided once the gesture pauses.
  const paintRequest = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A live page runs in a process of its own, which redraws it from scratch at
  // every new scale; through a pinch that is most of the work on the machine.
  // Live pages step aside for their previews while a gesture runs, staying
  // loaded, and return when it settles.
  const setLivePagesPaused = useCallback((paused: boolean) => {
    for (const frame of worldRef.current?.querySelectorAll("iframe") ?? []) {
      frame.style.visibility = paused ? "hidden" : "";
    }
  }, []);

  const settleView = useCallback(() => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    const view = viewRef.current;
    if (!view) return;
    // A promoted layer keeps the resolution it was drawn at, so a zoom leaves
    // it blurry; dropping the hint redraws it sharp at the new scale.
    if (worldRef.current) worldRef.current.style.willChange = "auto";
    setLivePagesPaused(false);
    holdPreviewPrewarm(false);
    setLabelZoom(view.zoom);
    // Widths change only here, so a gesture never lays the labels out.
    for (const frame of layoutFramesRef.current) {
      const label = labelElementsRef.current.get(frame.key);
      if (label) label.style.width = `${frame.width * view.zoom}px`;
    }
    refreshLiveRef.current();
    savedViews.set(viewKey, { page: pageIndex, view });
  }, [pageIndex, viewKey, setLivePagesPaused]);

  const paintView = useCallback(() => {
    paintRequest.current = 0;
    const view = viewRef.current;
    const world = worldRef.current;
    if (!view) return;
    if (world) world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    if (zoomReadoutRef.current) {
      zoomReadoutRef.current.textContent = `${Math.round(view.zoom * 100)}%`;
    }
    const grid = gridRef.current;
    if (grid) grid.style.transform = gridTransform(view);
    // Labels: a pan moves their layer on the GPU. A zoom moves each label on
    // screen by its own transform (a variable they inherited would restyle
    // every element inside every label), and labels off screen stay hidden.
    const labels = labelsRef.current;
    const labelLayer = labelLayerRef.current;
    if (!labels || !labelLayer) return;
    labelLayer.style.transform = `translate(${view.x}px, ${view.y}px)`;
    const hidden = view.zoom < LABEL_MIN_ZOOM;
    if (labels.hidden !== hidden) labels.hidden = hidden;
    if (hidden) return;
    const zoomChanged = labelZoomRef.current !== view.zoom;
    labelZoomRef.current = view.zoom;
    const { width, height } = viewportSizeRef.current;
    for (const frame of layoutFramesRef.current) {
      const label = labelElementsRef.current.get(frame.key);
      if (!label) continue;
      const left = frame.x * view.zoom + view.x;
      const top = frame.y * view.zoom + view.y;
      const onScreen =
        left < width &&
        left + frame.width * view.zoom > 0 &&
        top - 32 < height &&
        top > -frame.height * view.zoom;
      if (!onScreen) {
        if (label.style.visibility !== "hidden") label.style.visibility = "hidden";
        continue;
      }
      if (zoomChanged || label.style.visibility === "hidden") {
        label.style.transform = `translate(${frame.x * view.zoom}px, ${frame.y * view.zoom}px) translateY(-100%)`;
      }
      if (label.style.visibility === "hidden") label.style.visibility = "";
    }
  }, []);

  /** Shows `view`: at once for a discrete step, or as part of a gesture. */
  const applyView = useCallback(
    (view: CanvasView, gesture = false) => {
      viewRef.current = view;
      if (!gesture) {
        cancelAnimationFrame(paintRequest.current);
        paintView();
        settleView();
        return;
      }
      // Moving as one GPU layer for the length of the gesture.
      const world = worldRef.current;
      if (world && world.style.willChange !== "transform") {
        world.style.willChange = "transform";
        setLivePagesPaused(true);
        holdPreviewPrewarm(true);
      }
      // Trackpads send several events per frame; draw once per frame.
      if (!paintRequest.current) paintRequest.current = requestAnimationFrame(paintView);
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(settleView, GESTURE_SETTLE_MS);
    },
    [paintView, settleView, setLivePagesPaused],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(paintRequest.current);
      if (settleTimer.current !== null) {
        clearTimeout(settleTimer.current);
        holdPreviewPrewarm(false);
      }
    },
    [],
  );

  // Fitting hands the view back to the panel size until the user moves it again.
  const fitAll = useCallback(() => {
    autoFitRef.current = true;
    const size = viewportSizeRef.current;
    applyView(
      fitViewToRect(
        { x: 0, y: 0, width: layout.width, height: layout.height },
        { ...size, top: TOOLBAR_SPACE },
        24,
      ),
    );
  }, [applyView, layout.width, layout.height]);

  const zoomToFrame = useCallback(
    (frame: PlacedFrame) => {
      autoFitRef.current = false;
      const size = viewportSizeRef.current;
      applyView(
        fitViewToRect(
          { x: frame.x, y: frame.y - 40, width: frame.width, height: frame.height + 40 },
          { ...size, top: TOOLBAR_SPACE },
          32,
        ),
      );
    },
    [applyView],
  );

  const zoomBy = useCallback(
    (factor: number, cx?: number, cy?: number) => {
      const view = viewRef.current;
      if (!view) return;
      autoFitRef.current = false;
      const size = viewportSizeRef.current;
      applyView(zoomViewAt(view, factor, cx ?? size.width / 2, cy ?? size.height / 2));
    },
    [applyView],
  );

  // The labels paintView places: found once per layout, not on every frame.
  useLayoutEffect(() => {
    layoutFramesRef.current = layout.frames;
    const elements = new Map<string, HTMLElement>();
    for (const element of labelLayerRef.current?.children ?? []) {
      if (element instanceof HTMLElement && element.dataset.frameKey) {
        elements.set(element.dataset.frameKey, element);
      }
    }
    labelElementsRef.current = elements;
    labelZoomRef.current = null;
    paintView();
  }, [layout.frames, paintView]);

  // First paint of a page: restore the saved view, or fit everything.
  const initializedPageRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (initializedPageRef.current === pageIndex) return;
    const restore = initializedPageRef.current === null ? viewRef.current : null;
    initializedPageRef.current = pageIndex;
    viewportSizeRef.current = viewportSize(viewportRef.current);
    setLiveKey(null);
    setSelectedKey(null);
    if (restore) applyView(restore);
    else {
      autoFitRef.current = true;
      fitAll();
    }
  }, [applyView, fitAll, pageIndex]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return observeResize(viewport, () => {
      viewportSizeRef.current = viewportSize(viewport);
      if (autoFitRef.current) fitAll();
      else refreshLiveRef.current();
    });
  }, [fitAll]);

  // Wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // Read once per gesture: measuring on every event would force a layout.
    let rect: DOMRect | null = null;
    let rectAt = 0;
    const onWheel = (event: WheelEvent) => {
      const view = viewRef.current;
      if (!view) return;
      event.preventDefault();
      if (rect === null || event.timeStamp - rectAt > GESTURE_SETTLE_MS) {
        rect = viewport.getBoundingClientRect();
      }
      rectAt = event.timeStamp;
      autoFitRef.current = false;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey) {
        applyView(
          zoomViewAt(
            view,
            wheelZoomFactor(dy),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
          true,
        );
      } else if (event.shiftKey && dx === 0) {
        applyView({ ...view, x: view.x - dy }, true);
      } else {
        applyView({ ...view, x: view.x - dx, y: view.y - dy }, true);
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [applyView]);

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; view: CanvasView } | null>(null);
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const pointerRect = useRef<DOMRect | null>(null);

  const frameKeyAt = (target: EventTarget | null): string | null =>
    target instanceof Element
      ? (target.closest<HTMLElement>("[data-frame-key]")?.dataset.frameKey ?? null)
      : null;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 2) return;
    if (event.target instanceof Element && event.target.closest("button, [role='combobox']"))
      return;
    const key = frameKeyAt(event.target);
    if (liveKey !== null && key !== liveKey) setLiveKey(null);
    setSelectedKey(key);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pointerRect.current = event.currentTarget.getBoundingClientRect();
    const view = viewRef.current;
    if (!view) return;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: view.zoom };
      drag.current = null;
    } else {
      drag.current = { x: event.clientX, y: event.clientY, view };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const view = viewRef.current;
    if (!view) return;
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const rect = pointerRect.current ?? event.currentTarget.getBoundingClientRect();
      autoFitRef.current = false;
      const target =
        (pinch.current.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.current.distance;
      applyView(
        zoomViewAt(
          view,
          target / view.zoom,
          (a!.x + b!.x) / 2 - rect.left,
          (a!.y + b!.y) / 2 - rect.top,
        ),
        true,
      );
      return;
    }
    if (drag.current) {
      autoFitRef.current = false;
      applyView(
        {
          ...view,
          x: drag.current.view.x + event.clientX - drag.current.x,
          y: drag.current.view.y + event.clientY - drag.current.y,
        },
        true,
      );
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
  };

  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Pointer capture retargets the event to the board; find what is under it.
    const key = frameKeyAt(document.elementFromPoint(event.clientX, event.clientY));
    window.getSelection()?.removeAllRanges();
    if (key !== null) setLiveKey(key);
    else fitAll();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Escape") {
      if (liveKey !== null) setLiveKey(null);
      else setSelectedKey(null);
      return;
    }
    const selected = layout.frames.find((frame) => frame.key === selectedKey);
    const actions: Record<string, () => void> = {
      "1": fitAll,
      "0": () => zoomBy(1 / (viewRef.current?.zoom ?? 1)),
      "=": () => zoomBy(1.25),
      "+": () => zoomBy(1.25),
      "-": () => zoomBy(0.8),
      "2": () => selected && zoomToFrame(selected),
    };
    const action = actions[event.key];
    if (!action || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    action();
  };

  const liveFrame = layout.frames.find((frame) => frame.key === liveKey);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <ArtifactHeader picker={props.picker} onReload={props.onReload} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={viewportRef}
          tabIndex={0}
          // Its single-key shortcuts (1, 0, +, -) must not type into the composer.
          role="application"
          aria-label="Design canvas"
          className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-muted/40 outline-none select-none active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onDoubleClick={onDoubleClick}
          onKeyDown={onKeyDown}
        >
          {/* Twice the panel plus a tile, so its transform can cover it at any spacing. */}
          <div
            ref={gridRef}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 origin-top-left will-change-transform"
            style={{
              width: `calc(200% + ${GRID_TILE * 2}px)`,
              height: `calc(200% + ${GRID_TILE * 2}px)`,
              backgroundImage: "radial-gradient(var(--color-border) 1.25px, transparent 1.25px)",
              backgroundSize: `${GRID_TILE}px ${GRID_TILE}px`,
            }}
          />
          <div ref={worldRef} className="absolute top-0 left-0 origin-top-left">
            {layout.headings.map((heading) => (
              <h2
                key={heading.key}
                className="absolute m-0 font-bold tracking-tight whitespace-nowrap text-foreground"
                style={{ left: heading.x, top: heading.y, fontSize: HEADING_SIZE, lineHeight: 1 }}
              >
                {heading.title}
              </h2>
            ))}
            {layout.frames.map((frame) => (
              <DesignFrameView
                key={frame.key}
                frame={frame}
                root={props.root}
                tokenFile={tokenFiles.get(frameDirectory(frame.file)) ?? frame.file}
                environmentId={props.environmentId}
                cwd={props.cwd}
                threadRef={props.threadRef}
                draft={props.draft}
                designRevision={props.designRevision}
                live={frame.key === liveKey}
                mounted={liveKeys.has(frame.key)}
                tiles={tilesByKey.get(frame.key) ?? ""}
                near={nearKeys.has(frame.key)}
                selected={frame.key === selectedKey}
                onPreviewFailed={markPreviewFailed}
                loader={previewLoader}
              />
            ))}
          </div>
          <div ref={labelsRef} className="pointer-events-none absolute inset-0 overflow-hidden">
            <div ref={labelLayerRef} className="absolute top-0 left-0 will-change-transform">
              {layout.frames.map((frame) => (
                <FrameLabel
                  key={frame.key}
                  frame={frame}
                  relativePath={`${props.root}/${frame.file.split("#", 1)[0]}`}
                  accent={frame.key === liveKey || frame.key === selectedKey}
                  fit={labelFit(frame.width * labelZoom)}
                  onOpenFile={props.onOpenFile}
                  onZoomTo={zoomToFrame}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-2 top-2 flex items-start justify-between gap-2">
          {props.canvas.pages.length > 1 ? (
            <div className="pointer-events-auto flex min-w-0 items-center gap-1 rounded-lg border bg-popover p-1 shadow-sm">
              <Select
                value={String(pageIndex)}
                onValueChange={(value) => setPageIndex(Number(value))}
              >
                <SelectTrigger
                  size="sm"
                  variant="ghost"
                  aria-label="Canvas page"
                  className="w-auto"
                >
                  <SelectValue>{page?.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {props.canvas.pages.map((entry, index) => (
                    <SelectItem key={`${entry.name}:${index}`} hideIndicator value={String(index)}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : (
            <div />
          )}
          <div className="pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-sm">
            <ToolbarButton label="Zoom out (−)" onClick={() => zoomBy(0.8)}>
              <Minus />
            </ToolbarButton>
            <Button
              size="sm"
              variant="ghost"
              className="min-w-14"
              aria-label="Zoom to 100% (0)"
              onClick={() => zoomBy(1 / (viewRef.current?.zoom ?? 1))}
            >
              {/* Written by paintView, so it follows a gesture frame by frame. */}
              <span ref={zoomReadoutRef} className="tabular-nums" />
            </Button>
            <ToolbarButton label="Zoom in (+)" onClick={() => zoomBy(1.25)}>
              <Plus />
            </ToolbarButton>
            <ToolbarButton label="Fit everything (1)" onClick={fitAll}>
              <Maximize />
            </ToolbarButton>
          </div>
        </div>

        {liveFrame || props.warning ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
            <div className="max-w-full truncate rounded-lg border bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
              {liveFrame ? (
                <>
                  Using <span className="font-medium text-foreground">{liveFrame.title}</span> · Esc
                  or click outside to return to the canvas
                </>
              ) : (
                props.warning
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const frameDirectory = (file: string) => {
  const path = file.split("#", 1)[0]!;
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
};

/** The asset URL for `file`, from one issued for a file in the same folder. */
function siblingAssetUrl(url: string, file: string): string {
  const name = file.split("#", 1)[0]!.split("/").pop() ?? "";
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  return `${path.slice(0, path.lastIndexOf("/") + 1)}${encodeURIComponent(name)}${query === -1 ? "" : url.slice(query)}`;
}

/**
 * A screen's name above it, the same size on screen at any zoom. The board
 * places labels in screen space; their width, and what fits in it, follows
 * the settled zoom, so a gesture neither lays them out nor re-renders them.
 */
type LabelFit = 0 | 1 | 2;
const labelFit = (width: number): LabelFit => (width > 240 ? 2 : width > 110 ? 1 : 0);

const FrameLabel = memo(function FrameLabel(props: {
  readonly frame: PlacedFrame;
  readonly relativePath: string;
  readonly accent: boolean;
  /** What fits beside the name at the settled zoom: 0 nothing, 1 the button, 2 also the size. */
  readonly fit: LabelFit;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onZoomTo: (frame: PlacedFrame) => void;
}) {
  const { frame, relativePath } = props;
  return (
    <div
      data-frame-key={frame.key}
      className={cn(
        "pointer-events-auto absolute top-0 left-0 flex h-[26px] items-center gap-1 text-xs whitespace-nowrap text-muted-foreground",
        props.accent && "text-primary",
      )}
      // Placed, sized and hidden off screen by the board, outside React.
      style={{ visibility: "hidden" }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        props.onZoomTo(frame);
      }}
    >
      <span className="min-w-0 flex-1 truncate">{frame.title}</span>
      {props.fit === 2 ? (
        <span className="tabular-nums opacity-70">
          {frame.width} × {frame.height}
        </span>
      ) : null}
      {props.fit >= 1 ? (
        // A native tooltip: a component one per label would cost every re-render.
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Open ${relativePath}`}
          title="Open the screen's file"
          onClick={() => props.onOpenFile(relativePath)}
        >
          <FileCode2 />
        </Button>
      ) : null}
    </div>
  );
});

const DesignFrameView = memo(function DesignFrameView(props: {
  readonly frame: PlacedFrame;
  readonly root: string;
  /** A screen in the same folder whose asset URL this frame borrows. */
  readonly tokenFile: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly designRevision: string | null;
  readonly live: boolean;
  /** Runs as a live page over its preview image. */
  readonly mounted: boolean;
  /** Sharp preview tiles in view, as a comma list of tile indices. */
  readonly tiles: string;
  /** In or near the view, so its preview is fetched ahead of the others. */
  readonly near: boolean;
  readonly selected: boolean;
  readonly onPreviewFailed: (key: string) => void;
  readonly loader: PreviewLoader;
}) {
  const { frame } = props;
  const relativePath = `${props.root}/${frame.file.split("#", 1)[0]}`;
  // An asset URL serves every file beside the one it was issued for, so the
  // frames in one folder share a single URL (one request, not one per screen).
  const tokenPath = `${props.root}/${props.tokenFile}`;
  const resource = useMemo(
    () =>
      workspaceAssetResource({
        kind: "workspace-file",
        threadRef: props.threadRef,
        draft: props.draft,
        workspaceRoot: props.cwd,
        // Relative, so the URL is scoped to the folder: an absolute draft path
        // would serve that one file only, and its sibling screens and assets
        // would not load.
        absolutePath: tokenPath,
      }),
    [props.threadRef, props.draft, props.cwd, tokenPath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  // One set of URLs per revision: a re-minted token alone must not reload anything.
  const [src, setSrc] = useState<{
    readonly revision: string | null;
    readonly page: string;
    readonly preview: string;
  } | null>(null);
  const liveUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  useEffect(() => {
    if (liveUrl === null) return;
    setSrc((current) => {
      if (current !== null && current.revision === props.designRevision) return current;
      const fileUrl = siblingAssetUrl(liveUrl, frame.file);
      return {
        revision: props.designRevision,
        page: screenFrameSrc(fileUrl, frame.file, props.designRevision),
        preview: screenThumbnailSrc(fileUrl, frame, props.designRevision),
      };
    });
  }, [liveUrl, frame, props.designRevision]);

  // The server answers 503 while its browser installs; a few retries cover that.
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    },
    [],
  );
  const previewUrl =
    src === null
      ? null
      : `${src.preview}${previewAttempt === 0 ? "" : `&attempt=${previewAttempt}`}`;
  const overview = usePreviewImage(
    props.loader,
    previewUrl,
    props.near ? PREVIEW_PRIORITY.near : PREVIEW_PRIORITY.far,
  );
  const { onPreviewFailed } = props;
  useEffect(() => {
    if (overview !== null || previewUrl === null) return;
    if (previewAttempt >= PREVIEW_RETRIES) {
      onPreviewFailed(frame.key);
      return;
    }
    retryTimer.current = setTimeout(
      () => setPreviewAttempt((attempt) => attempt + 1),
      PREVIEW_RETRY_MS,
    );
  }, [overview, previewUrl, previewAttempt, onPreviewFailed, frame.key]);
  // Tiles stay once asked for (until the screen changes), so moving back over
  // a part already seen never blurs it again.
  const [shownTiles, setShownTiles] = useState<{
    readonly preview: string | null;
    readonly indices: ReadonlyArray<number>;
  }>({ preview: null, indices: [] });
  const wanted = props.tiles === "" ? [] : props.tiles.split(",").map(Number);
  const tilesCurrent = shownTiles.preview === previewUrl;
  if (!tilesCurrent || wanted.some((index) => !shownTiles.indices.includes(index))) {
    setShownTiles({
      preview: previewUrl,
      indices: [...new Set([...(tilesCurrent ? shownTiles.indices : []), ...wanted])].slice(
        -MAX_TILES_PER_SCREEN,
      ),
    });
  }
  const [loadedPage, setLoadedPage] = useState<string | null>(null);
  // A page that leaves must load again before it covers its preview next time.
  if (!props.mounted && loadedPage !== null) setLoadedPage(null);
  const pageShown = props.mounted && src !== null && loadedPage === src.page;

  const accent = props.live || props.selected;
  return (
    <div
      data-frame-key={frame.key}
      className="absolute"
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      <div
        className={cn(
          "absolute inset-0 overflow-hidden rounded-xs bg-white shadow-lg",
          accent && "outline-2 outline-primary",
        )}
      >
        {assetUrl._tag === "Failure" ? (
          <div className="flex size-full items-center justify-center p-6 text-center text-2xl text-muted-foreground">
            Couldn't load {relativePath}
          </div>
        ) : (
          <div
            aria-hidden
            className="flex size-full items-center justify-center bg-muted/60 text-center leading-tight text-muted-foreground"
            style={{ fontSize: Math.max(12, frame.width / 9), padding: frame.width / 12 }}
          >
            {frame.title}
          </div>
        )}
        {overview ? (
          <img
            src={overview}
            alt=""
            draggable={false}
            decoding="async"
            className="absolute inset-0 size-full"
          />
        ) : null}
        {previewUrl !== null && tilesCurrent
          ? shownTiles.indices.map((index) => (
              <PreviewTile
                key={index}
                loader={props.loader}
                url={`${previewUrl}&tile=${index}`}
                top={index * SCREEN_PREVIEW_TILE_HEIGHT}
                frameHeight={frame.height}
              />
            ))
          : null}
        {props.mounted && src !== null ? (
          <iframe
            src={src.page}
            title={frame.title}
            sandbox="allow-scripts allow-forms allow-popups allow-downloads"
            scrolling={frame.scroll ? "auto" : "no"}
            // Hidden until it has painted, so the preview never gives way to a blank page.
            className={cn(
              "absolute inset-0 block size-full border-0 bg-white",
              !pageShown && "opacity-0",
              !props.live && "pointer-events-none",
            )}
            onLoad={() => setLoadedPage(src.page)}
          />
        ) : null}
      </div>
    </div>
  );
});

const PreviewTile = memo(function PreviewTile(props: {
  readonly loader: PreviewLoader;
  readonly url: string;
  readonly top: number;
  readonly frameHeight: number;
}) {
  const image = usePreviewImage(props.loader, props.url, PREVIEW_PRIORITY.tile);
  if (!image) return null;
  return (
    <img
      src={image}
      alt=""
      draggable={false}
      decoding="async"
      className="absolute inset-x-0 w-full"
      style={{
        top: props.top,
        height: Math.min(SCREEN_PREVIEW_TILE_HEIGHT, props.frameHeight - props.top),
      }}
    />
  );
});
