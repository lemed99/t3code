import "@xyflow/react/dist/base.css";

import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { SCREEN_PREVIEW_TILE_HEIGHT } from "@t3tools/shared/htmlRender";
import {
  type Node,
  type NodeProps,
  ReactFlow,
  ReactFlowProvider,
  type Viewport,
  useReactFlow,
} from "@xyflow/react";
import { FileCode2, Maximize, Minus, Plus } from "lucide-react";
import {
  type ReactNode,
  createContext,
  memo,
  use,
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
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { workspaceAssetResource } from "../files/filePreviewMode";
import { ArtifactHeader, type DesignCanvasPanelProps, ToolbarButton } from "./artifactChrome";
import {
  type CanvasView,
  type DesignCanvas,
  HEADING_SIZE,
  MAX_ZOOM,
  MIN_ZOOM,
  type PlacedFrame,
  detailTiles,
  fitViewToRect,
  frameDirectory,
  gridTransform,
  layoutDesignPage,
  liveFrameKeys,
  liveFrameMinWidth,
  screenFrameSrc,
  screenThumbnailSrc,
  siblingAssetUrl,
  stepLiveFrames,
  zoomViewAt,
} from "./designCanvas.logic";
import {
  PREVIEW_PRIORITY,
  PreviewLoader,
  holdPreviewPrewarm,
  usePreviewImage,
} from "./previewLoader";

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
const LIVE_DRAWING_OPACITY = "0.01";
const LIVE_REVEAL_MS = 250;

const viewportSize = (viewport: HTMLElement | null) => ({
  width: viewport?.clientWidth ?? 800,
  height: viewport?.clientHeight ?? 600,
});

// Views survive the panel unmounting while another tab is shown.
const savedViews = new Map<string, { page: number; view: CanvasView }>();

/** What every screen on a board shares, so node data stays per screen. */
interface BoardContextValue {
  readonly root: string;
  readonly tokenFiles: ReadonlyMap<string, string>;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly designRevision: string | null;
  readonly onPreviewFailed: (key: string) => void;
  readonly loader: PreviewLoader;
}
const BoardContext = createContext<BoardContextValue | null>(null);

type ScreenNodeData = {
  readonly frame: PlacedFrame;
  readonly live: boolean;
  readonly mounted: boolean;
  readonly tiles: string;
  readonly near: boolean;
  readonly selected: boolean;
};
type ScreenNode = Node<ScreenNodeData, "screen">;
type HeadingNode = Node<{ readonly title: string }, "heading">;
type BoardNode = ScreenNode | HeadingNode;

const ScreenNodeView = memo(function ScreenNodeView({ data }: NodeProps<ScreenNode>) {
  const board = use(BoardContext);
  if (!board) return null;
  return (
    <DesignFrameView
      frame={data.frame}
      root={board.root}
      tokenFile={board.tokenFiles.get(frameDirectory(data.frame.file)) ?? data.frame.file}
      environmentId={board.environmentId}
      cwd={board.cwd}
      threadRef={board.threadRef}
      draft={board.draft}
      designRevision={board.designRevision}
      live={data.live}
      mounted={data.mounted}
      tiles={data.tiles}
      near={data.near}
      selected={data.selected}
      onPreviewFailed={board.onPreviewFailed}
      loader={board.loader}
    />
  );
});

const HeadingNodeView = memo(function HeadingNodeView({ data }: NodeProps<HeadingNode>) {
  return (
    <h2
      className="m-0 font-bold tracking-tight whitespace-nowrap text-foreground"
      style={{ fontSize: HEADING_SIZE, lineHeight: 1 }}
    >
      {data.title}
    </h2>
  );
});

const NODE_TYPES = { screen: ScreenNodeView, heading: HeadingNodeView };

/**
 * A design page on a React Flow canvas: React Flow pans, pinches, scrolls and
 * zooms; the board decides which screens run live and which previews load.
 */
export function DesignBoard(
  props: DesignCanvasPanelProps & {
    readonly canvas: DesignCanvas;
    /** Folder the canvas's screen paths are relative to. */
    readonly root: string;
    readonly warning: string | null;
    readonly onReload: () => void;
    readonly picker: ReactNode;
  },
) {
  return (
    <ReactFlowProvider>
      <DesignBoardCanvas {...props} />
    </ReactFlowProvider>
  );
}

function DesignBoardCanvas(
  props: DesignCanvasPanelProps & {
    readonly canvas: DesignCanvas;
    readonly root: string;
    readonly warning: string | null;
    readonly onReload: () => void;
    readonly picker: ReactNode;
  },
) {
  const flow = useReactFlow<BoardNode>();
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
  // The sharp tiles each screen in view needs, as a comma list per frame key.
  const [tilesByKey, setTilesByKey] = useState<ReadonlyMap<string, string>>(() => new Map());
  // Screens in or near the view, whose previews are fetched first.
  const [nearKeys, setNearKeys] = useState<ReadonlySet<string>>(() => new Set());
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Until the user pans or zooms, the view follows the panel's size: it opens
  // with an animation, so the first measurement is rarely the final one.
  const autoFitRef = useRef(saved === undefined);

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

  // Live pages go transparent during a gesture, so a zoom never re-rasters
  // them (each is a separate process) and their preview shows instead. Coming
  // back they are drawn barely visible first: a transparent page skips
  // painting the frames nested in it, and showing it at once would flash it
  // with those frames empty. The preview under it is the same picture.
  const liveRevealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setLivePagesPaused = useCallback((paused: boolean) => {
    const setOpacity = (opacity: string) => {
      for (const frame of viewportRef.current?.querySelectorAll("iframe") ?? []) {
        frame.style.opacity = opacity;
      }
    };
    if (liveRevealTimer.current !== null) clearTimeout(liveRevealTimer.current);
    liveRevealTimer.current = null;
    if (paused) {
      setOpacity("0");
      return;
    }
    setOpacity(LIVE_DRAWING_OPACITY);
    liveRevealTimer.current = setTimeout(() => {
      liveRevealTimer.current = null;
      setOpacity("");
    }, LIVE_REVEAL_MS);
  }, []);

  // A gesture only moves React Flow's viewport and repaints the labels, grid
  // and zoom readout; screens decide what to show once it settles.
  const gestureRef = useRef(false);
  const flowViewportRef = useRef<HTMLElement | null>(null);
  const paintRequest = useRef(0);
  const paintView = useCallback(() => {
    paintRequest.current = 0;
    const view = viewRef.current;
    if (!view) return;
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

  const settleView = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (gestureRef.current) {
      gestureRef.current = false;
      // A promoted layer keeps the resolution it was drawn at, so a zoom
      // leaves it blurry; dropping the hint redraws it sharp at the new scale.
      if (flowViewportRef.current) flowViewportRef.current.style.willChange = "";
      setLivePagesPaused(false);
      holdPreviewPrewarm(false);
    }
    setLabelZoom(view.zoom);
    // Widths change only here, so a gesture never lays the labels out.
    for (const frame of layoutFramesRef.current) {
      const label = labelElementsRef.current.get(frame.key);
      if (label) label.style.width = `${frame.width * view.zoom}px`;
    }
    refreshLiveRef.current();
    savedViews.set(viewKey, { page: pageIndex, view });
  }, [pageIndex, viewKey, setLivePagesPaused]);

  const onMoveStart = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      // Moves the board makes itself (fit, zoom buttons) arrive without an event.
      if (event === null) return;
      autoFitRef.current = false;
      gestureRef.current = true;
      // Moving as one GPU layer for the length of the gesture.
      flowViewportRef.current ??=
        viewportRef.current?.querySelector(".react-flow__viewport") ?? null;
      if (flowViewportRef.current) flowViewportRef.current.style.willChange = "transform";
      setLivePagesPaused(true);
      holdPreviewPrewarm(true);
    },
    [setLivePagesPaused],
  );
  const onMove = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      viewRef.current = viewport;
      // Trackpads send several events per frame; draw once per frame.
      if (!paintRequest.current) paintRequest.current = requestAnimationFrame(paintView);
    },
    [paintView],
  );
  const onMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      viewRef.current = viewport;
      cancelAnimationFrame(paintRequest.current);
      paintView();
      settleView();
    },
    [paintView, settleView],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(paintRequest.current);
      if (liveRevealTimer.current !== null) clearTimeout(liveRevealTimer.current);
      if (gestureRef.current) holdPreviewPrewarm(false);
    },
    [],
  );

  /** Shows `view` at once; React Flow reports it back through onMove. */
  const applyView = useCallback(
    (view: CanvasView) => {
      viewRef.current = view;
      void flow.setViewport(view);
      paintView();
      settleView();
    },
    [flow, paintView, settleView],
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
    (factor: number) => {
      const view = viewRef.current;
      if (!view) return;
      autoFitRef.current = false;
      const size = viewportSizeRef.current;
      applyView(zoomViewAt(view, factor, size.width / 2, size.height / 2));
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
  const [flowReady, setFlowReady] = useState(false);
  const initializedPageRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!flowReady || initializedPageRef.current === pageIndex) return;
    const restore = initializedPageRef.current === null ? viewRef.current : null;
    initializedPageRef.current = pageIndex;
    viewportSizeRef.current = viewportSize(viewportRef.current);
    setLiveKey(null);
    setSelectedKey(null);
    if (restore) applyView(restore);
    else fitAll();
  }, [applyView, fitAll, flowReady, pageIndex]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    return observeResize(viewport, () => {
      viewportSizeRef.current = viewportSize(viewport);
      if (autoFitRef.current) fitAll();
      else refreshLiveRef.current();
    });
  }, [fitAll]);

  // Data is per screen and flat: a screen whose fields did not change skips
  // its re-render (DesignFrameView is memoized on them).
  const nodes = useMemo(
    (): Array<BoardNode> => [
      ...layout.headings.map((heading): BoardNode => ({
        id: `heading:${heading.key}`,
        type: "heading",
        position: { x: heading.x, y: heading.y },
        data: { title: heading.title },
        draggable: false,
        selectable: false,
        focusable: false,
      })),
      ...layout.frames.map((frame): BoardNode => {
        const live = frame.key === liveKey;
        return {
          id: frame.key,
          type: "screen",
          position: { x: frame.x, y: frame.y },
          width: frame.width,
          height: frame.height,
          data: {
            frame,
            live,
            mounted: liveKeys.has(frame.key),
            tiles: tilesByKey.get(frame.key) ?? "",
            near: nearKeys.has(frame.key),
            selected: frame.key === selectedKey,
          },
          draggable: false,
          selectable: false,
          focusable: false,
          // A screen in use takes its own clicks, drags and scrolling.
          ...(live ? { className: "nopan nodrag nowheel" } : {}),
        };
      }),
    ],
    [layout, liveKey, liveKeys, tilesByKey, nearKeys, selectedKey],
  );

  const board = useMemo<BoardContextValue>(
    () => ({
      root: props.root,
      tokenFiles,
      environmentId: props.environmentId,
      cwd: props.cwd,
      threadRef: props.threadRef,
      draft: props.draft,
      designRevision: props.designRevision,
      onPreviewFailed: markPreviewFailed,
      loader: previewLoader,
    }),
    [
      props.root,
      tokenFiles,
      props.environmentId,
      props.cwd,
      props.threadRef,
      props.draft,
      props.designRevision,
      markPreviewFailed,
      previewLoader,
    ],
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: BoardNode) => {
      const key = node.type === "screen" ? node.id : null;
      if (liveKey !== null && key !== liveKey) setLiveKey(null);
      setSelectedKey(key);
    },
    [liveKey],
  );
  const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: BoardNode) => {
    window.getSelection()?.removeAllRanges();
    if (node.type === "screen") setLiveKey(node.id);
  }, []);
  const onPaneClick = useCallback(() => {
    setLiveKey(null);
    setSelectedKey(null);
  }, []);
  const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Double-clicking empty canvas fits everything, as before.
    if (event.target instanceof Element && event.target.closest(".react-flow__pane")) {
      if (!event.target.closest(".react-flow__node")) fitAll();
    }
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
          className="relative min-h-0 flex-1 overflow-hidden bg-muted/40 outline-none select-none"
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
          <BoardContext value={board}>
            <ReactFlow<BoardNode>
              nodes={nodes}
              nodeTypes={NODE_TYPES}
              defaultViewport={saved?.view ?? { x: 0, y: 0, zoom: 1 }}
              minZoom={MIN_ZOOM}
              maxZoom={MAX_ZOOM}
              // Figma's trackpad model: two fingers pan, a pinch or ⌘/Ctrl zooms.
              panOnScroll
              panOnScrollSpeed={1}
              zoomOnScroll={false}
              zoomOnPinch
              zoomOnDoubleClick={false}
              panOnDrag
              selectionOnDrag={false}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              nodesFocusable={false}
              edgesFocusable={false}
              disableKeyboardA11y
              deleteKeyCode={null}
              selectionKeyCode={null}
              multiSelectionKeyCode={null}
              // Every screen stays mounted: one dropped off screen would lose
              // its loaded preview and live page, and flash coming back.
              onlyRenderVisibleElements={false}
              // React Flow asks for its credit unless you subscribe to its Pro plan.
              attributionPosition="bottom-left"
              style={{ position: "absolute", inset: 0 }}
              onInit={() => setFlowReady(true)}
              onMoveStart={onMoveStart}
              onMove={onMove}
              onMoveEnd={onMoveEnd}
              onNodeClick={onNodeClick}
              onNodeDoubleClick={onNodeDoubleClick}
              onPaneClick={onPaneClick}
            />
          </BoardContext>
          <div
            ref={labelsRef}
            className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
          >
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
  const [drawnPage, setDrawnPage] = useState<string | null>(null);
  // A page that leaves must load again before it covers its preview next time.
  if (!props.mounted && (loadedPage !== null || drawnPage !== null)) {
    setLoadedPage(null);
    setDrawnPage(null);
  }
  // Loaded is not yet painted, nested frames included: it covers its preview
  // a moment later.
  useEffect(() => {
    if (drawnPage === null) return;
    const timer = setTimeout(() => setLoadedPage(drawnPage), LIVE_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [drawnPage]);
  const pageShown = props.mounted && src !== null && loadedPage === src.page;

  const accent = props.live || props.selected;
  return (
    <div
      data-frame-key={frame.key}
      className="relative"
      style={{ width: frame.width, height: frame.height }}
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
            // Barely visible until it has painted, so the preview never gives
            // way to a blank page (fully transparent, it would not paint).
            className={cn(
              "absolute inset-0 block size-full border-0 bg-white",
              !pageShown && "opacity-1",
              !props.live && "pointer-events-none",
            )}
            onLoad={() => setDrawnPage(src.page)}
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
