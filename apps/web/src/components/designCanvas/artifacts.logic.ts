/**
 * A project's artifacts: the designs, documents and sheets the user keeps
 * beside the code. Each folder in `artifacts/` (or loose file there) is one
 * artifact; `design/` is the project's own design canvas. What a folder holds
 * decides how it shows: designs on the canvas, documents rendered, sheets as
 * a table.
 */

import { DESIGN_DIRECTORY, DESIGN_MANIFEST_PATH } from "./designCanvas.logic";

export const ARTIFACTS_DIRECTORY = "artifacts";
export const ARTIFACTS_INDEX_PATH = `${ARTIFACTS_DIRECTORY}/index.json`;
export const PROJECT_DESIGNS_ID = DESIGN_DIRECTORY;

export type ArtifactKind = "design" | "doc" | "sheet";

export type ArtifactContent =
  /** A T3 Code canvas: `canvas.json` listing HTML screens, paths relative to `root`. */
  | { readonly _tag: "ProjectCanvas"; readonly root: string }
  /** A Claude Design canvas: `canvas.json` and `.dc.html` screens in `root`. */
  | { readonly _tag: "ClaudeCanvas"; readonly root: string }
  /** HTML screens with no canvas file, shown side by side; paths relative to `root`. */
  | { readonly _tag: "Screens"; readonly root: string; readonly files: ReadonlyArray<string> }
  | { readonly _tag: "Document"; readonly path: string }
  | { readonly _tag: "Sheet"; readonly path: string; readonly delimiter: "," | "\t" };

export interface ProjectArtifact {
  /** Folder or file path relative to the project; stable across reloads. */
  readonly id: string;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly content: ArtifactContent;
  /** From `artifacts/index.json`, for ordering like the source app. */
  readonly updatedAt: string | null;
}

export interface ArtifactIndexEntry {
  readonly title: string | null;
  readonly updatedAt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * Reads `artifacts/index.json`: `{"<folder or file>": {"title", "updatedAt"}}`.
 * Optional and forgiving; a broken index only loses titles.
 */
export function parseArtifactIndex(
  contents: string | null,
): ReadonlyMap<string, ArtifactIndexEntry> {
  const index = new Map<string, ArtifactIndexEntry>();
  if (contents === null) return index;
  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return index;
  }
  const entries = isRecord(raw) && isRecord(raw.artifacts) ? raw.artifacts : raw;
  if (!isRecord(entries)) return index;
  for (const [name, value] of Object.entries(entries)) {
    if (!isRecord(value)) continue;
    index.set(name.replace(/^\.?\/+|\/+$/g, ""), {
      title: readString(value.title),
      updatedAt: readString(value.updatedAt),
    });
  }
  return index;
}

const HTML_FILE = /\.html?$/i;
const MARKDOWN_FILE = /\.(md|markdown)$/i;
const SHEET_FILE = /\.(csv|tsv)$/i;
const DOCUMENT_NAMES = ["document.md", "README.md", "index.md"];
// Bookkeeping files the sync writes next to an artifact's content.
const IGNORED_NAMES = new Set(["SOURCE.md"]);

export function titleFromName(name: string): string {
  const base = name
    .replace(/\.[^./]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base.length > 0 ? base[0]!.toUpperCase() + base.slice(1) : name;
}

const sheetContent = (path: string): ArtifactContent => ({
  _tag: "Sheet",
  path,
  delimiter: /\.tsv$/i.test(path) ? "\t" : ",",
});

/** How one artifact folder shows, from the files inside it. */
function folderContent(folder: string, files: ReadonlyArray<string>): ArtifactContent | null {
  const inside = files
    .map((path) => path.slice(folder.length + 1))
    .filter((path) => !IGNORED_NAMES.has(path.split("/").pop() ?? ""));
  const document = DOCUMENT_NAMES.find((name) => inside.includes(name));
  // A document may come with an HTML copy of itself; the Markdown is the document.
  if (document === "document.md") return { _tag: "Document", path: `${folder}/${document}` };
  const canvasFile = inside.find(
    (path) =>
      (path === "canvas.json" || path.endsWith("/canvas.json")) &&
      inside.some(
        (other) =>
          /\.dc\.html$/i.test(other) &&
          other.slice(0, other.lastIndexOf("/") + 1) === path.slice(0, path.lastIndexOf("/") + 1),
      ),
  );
  if (canvasFile !== undefined) {
    const dir = canvasFile.includes("/") ? canvasFile.slice(0, canvasFile.lastIndexOf("/")) : "";
    return { _tag: "ClaudeCanvas", root: dir ? `${folder}/${dir}` : folder };
  }
  if (inside.includes("canvas.json")) return { _tag: "ProjectCanvas", root: folder };
  const screens = inside
    .filter((path) => HTML_FILE.test(path))
    .toSorted((left, right) => left.localeCompare(right));
  if (screens.length > 0) return { _tag: "Screens", root: folder, files: screens };
  const sheet = inside.find((path) => SHEET_FILE.test(path));
  if (sheet !== undefined) return sheetContent(`${folder}/${sheet}`);
  const markdown = document ?? inside.find((path) => MARKDOWN_FILE.test(path));
  return markdown === undefined ? null : { _tag: "Document", path: `${folder}/${markdown}` };
}

const kindOf = (content: ArtifactContent): ArtifactKind =>
  content._tag === "Document" ? "doc" : content._tag === "Sheet" ? "sheet" : "design";

/**
 * Every artifact in the project, newest first when the index dates them, then
 * by title. `paths` is the project's recursive file listing.
 */
export function findProjectArtifacts(
  paths: ReadonlyArray<string>,
  index: ReadonlyMap<string, ArtifactIndexEntry>,
): ReadonlyArray<ProjectArtifact> {
  const artifacts: ProjectArtifact[] = [];
  const prefix = `${ARTIFACTS_DIRECTORY}/`;
  const folders = new Map<string, string[]>();
  for (const path of paths) {
    if (!path.startsWith(prefix) || path === ARTIFACTS_INDEX_PATH) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      const content = HTML_FILE.test(rest)
        ? ({ _tag: "Screens", root: ARTIFACTS_DIRECTORY, files: [rest] } as const)
        : SHEET_FILE.test(rest)
          ? sheetContent(path)
          : MARKDOWN_FILE.test(rest) && !IGNORED_NAMES.has(rest)
            ? ({ _tag: "Document", path } as const)
            : null;
      if (content !== null) {
        artifacts.push({
          id: path,
          title: index.get(rest)?.title ?? titleFromName(rest),
          kind: kindOf(content),
          content,
          updatedAt: index.get(rest)?.updatedAt ?? null,
        });
      }
      continue;
    }
    const folder = `${prefix}${rest.slice(0, slash)}`;
    folders.set(folder, [...(folders.get(folder) ?? []), path]);
  }
  for (const [folder, files] of folders) {
    const content = folderContent(folder, files);
    if (content === null) continue;
    const name = folder.slice(prefix.length);
    artifacts.push({
      id: folder,
      title: index.get(name)?.title ?? titleFromName(name),
      kind: kindOf(content),
      content,
      updatedAt: index.get(name)?.updatedAt ?? null,
    });
  }
  artifacts.sort(
    (left, right) =>
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
      left.title.localeCompare(right.title),
  );
  if (
    paths.some(
      (path) => path === DESIGN_MANIFEST_PATH || path.startsWith(`${DESIGN_DIRECTORY}/screens/`),
    )
  ) {
    artifacts.unshift({
      id: PROJECT_DESIGNS_ID,
      title: "Project designs",
      kind: "design",
      content: { _tag: "ProjectCanvas", root: DESIGN_DIRECTORY },
      updatedAt: null,
    });
  }
  return artifacts;
}
