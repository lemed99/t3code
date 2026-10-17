import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { FileCode2, FileText, Globe, Palette, SwatchBook, Table2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";

import ChatMarkdown from "../ChatMarkdown";
import { DelimitedTablePreview } from "../files/DelimitedTablePreview";
import { workspaceAssetResource } from "../files/filePreviewMode";
import { useProjectEntriesQuery, useProjectFileQuery } from "../files/projectFilesQueryState";
import {
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_FRAME_WIDTH,
  type DesignCanvas,
  type PlacedFrame,
  layoutDesignPage,
  parseClaudeDesignCanvas,
  parseDesignManifest,
  screenThumbnailSrc,
  screenTitleFromFile,
  frameDirectory,
  siblingAssetUrl,
  withUnlistedScreens,
} from "./designCanvas.logic";
import {
  ARTIFACTS_INDEX_PATH,
  type ProjectArtifact,
  findProjectArtifacts,
  parseArtifactIndex,
} from "./artifacts.logic";
import { ArtifactPageView } from "./ArtifactPageView";
import { PREWARM_DELAY_MS, queuePreviewPrewarm } from "./previewLoader";
import { DesignBoard } from "./DesignBoard";
import { DesignSystemView } from "./DesignSystemView";
import {
  ArtifactHeader,
  type ArtifactViewProps,
  type DesignCanvasPanelProps,
  PanelEmpty,
  PanelSpinner,
  ToolbarButton,
} from "./artifactChrome";

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
