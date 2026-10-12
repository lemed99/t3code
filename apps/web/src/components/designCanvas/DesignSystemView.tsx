import { BookOpen, Box, Copy, MoveHorizontal, Palette, SquareDashed, Type } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { useProjectEntriesQuery, useProjectFileQuery } from "../files/projectFilesQueryState";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { ArtifactHeader, type ArtifactViewProps, PanelEmpty, PanelSpinner } from "./artifactChrome";
import {
  type DesignTokens,
  colorValue,
  findFontStylesheet,
  parseDesignTokens,
  previewDocument,
  previewFixedWidth,
  readPreviewCard,
  tokensCss,
  typeSpecimenDocument,
} from "./designSystem.logic";

const SECTIONS = [
  { id: "overview", label: "Overview", icon: BookOpen },
  { id: "colors", label: "Colors", icon: Palette },
  { id: "type", label: "Typography", icon: Type },
  { id: "spacing", label: "Spacing", icon: MoveHorizontal },
  { id: "radius", label: "Corner radius", icon: SquareDashed },
  { id: "shadows", label: "Shadows", icon: Copy },
  { id: "components", label: "Components", icon: Box },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

// Previews come from the project; they run sandboxed with an opaque origin.
const PREVIEW_SANDBOX = "allow-scripts";

/**
 * A design system, read like one: its guide, its tokens drawn out, and every
 * component preview rendered with the tokens in place.
 */
export function DesignSystemView(props: ArtifactViewProps & { readonly root: string }) {
  const tokensFile = useArtifactText(props, `${props.root}/tokens.json`);
  const readme = useArtifactText(props, `${props.root}/README.md`);
  const components = useProjectEntriesQuery(
    props.environmentId,
    props.cwd,
    `${props.root}/components`,
  );
  const tokens = useMemo(() => parseDesignTokens(tokensFile ?? null), [tokensFile]);
  const componentDirs = useMemo(
    () =>
      (components.data?.entries ?? [])
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path)
        .toSorted((left, right) => left.localeCompare(right)),
    [components.data?.entries],
  );
  const coverDir = componentDirs.find((dir) => dir.endsWith("/Cover")) ?? null;
  const fontSourceDir = coverDir ?? componentDirs[0] ?? null;
  const fontSource = useArtifactText(props, fontSourceDir ? `${fontSourceDir}/preview.html` : null);
  const fontStylesheet = fontSource ? findFontStylesheet(fontSource) : null;

  const [section, setSection] = useState<SectionId>("overview");
  const [theme, setTheme] = useState<string | null>(null);
  const activeTheme = theme ?? tokens?.themes[0]?.id ?? null;

  if (!tokens) {
    if (tokensFile === undefined) return <PanelSpinner />;
    return (
      <PanelEmpty
        title="The design system can't be read"
        description={`${props.root}/tokens.json is missing or not valid JSON.`}
      />
    );
  }
  const css = tokensCss(tokens, activeTheme);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactHeader picker={props.picker} onReload={props.onReload}>
        {tokens.themes.length > 1 ? (
          <Select value={activeTheme ?? ""} onValueChange={(value) => value && setTheme(value)}>
            <SelectTrigger size="sm" variant="ghost" aria-label="Theme" className="w-auto">
              <SelectValue>
                {tokens.themes.find((entry) => entry.id === activeTheme)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {tokens.themes.map((entry) => (
                <SelectItem key={entry.id} hideIndicator value={entry.id}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </ArtifactHeader>
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Design system"
          className="flex w-44 shrink-0 flex-col gap-0.5 border-r p-2"
        >
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={section === entry.id ? "page" : undefined}
              onClick={() => setSection(entry.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                section === entry.id && "bg-accent text-foreground",
              )}
            >
              <entry.icon className="size-4 shrink-0" />
              <span className="truncate">{entry.label}</span>
            </button>
          ))}
        </nav>
        <div className="scrollbar-gutter-both min-h-0 min-w-0 flex-1 overflow-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 pt-8 pb-24">
            {section === "overview" ? (
              <>
                {coverDir ? (
                  <ComponentPreview {...props} dir={coverDir} css={css} framed={false} />
                ) : null}
                {readme ? (
                  <ChatMarkdown
                    text={readme}
                    cwd={props.cwd}
                    imageBaseDir={resolvePathLinkTarget(props.root, props.cwd)}
                    threadRef={props.threadRef}
                    className="artifact-document"
                  />
                ) : null}
              </>
            ) : section === "colors" ? (
              <ColorsSection tokens={tokens} />
            ) : section === "type" ? (
              <TypeSection tokens={tokens} theme={activeTheme} fontStylesheet={fontStylesheet} />
            ) : section === "spacing" ? (
              <TokenRows title="Spacing" tokens={tokens.spacing}>
                {(value) => (
                  <div className="h-3 rounded-sm bg-primary/70" style={{ width: value }} />
                )}
              </TokenRows>
            ) : section === "radius" ? (
              <TokenRows title="Corner radius" tokens={tokens.radius}>
                {(value) => (
                  <div
                    className="size-14 border-2 border-primary/60 bg-primary/10"
                    style={{ borderRadius: value }}
                  />
                )}
              </TokenRows>
            ) : section === "shadows" ? (
              <TokenRows title="Shadows" tokens={tokens.shadows}>
                {(value) => (
                  <div className="h-14 w-24 rounded-xl bg-white" style={{ boxShadow: value }} />
                )}
              </TokenRows>
            ) : (
              <ComponentsSection
                {...props}
                dirs={componentDirs.filter((dir) => dir !== coverDir)}
                css={css}
                isPending={components.isPending}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A file's text: undefined while loading, null when missing. */
function useArtifactText(props: ArtifactViewProps, path: string | null) {
  const file = useProjectFileQuery(props.environmentId, props.cwd, path, path !== null);
  if (path === null) return null;
  if (file.data) return file.data.contents;
  return file.isPending ? undefined : null;
}

function SectionTitle(props: { readonly children: ReactNode }) {
  return <h2 className="text-2xl font-medium">{props.children}</h2>;
}

function ColorsSection(props: { readonly tokens: DesignTokens }) {
  const themes = props.tokens.themes;
  return (
    <>
      <SectionTitle>Colors</SectionTitle>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3">
        {props.tokens.colors.map((token) => (
          <div key={token.name} className="overflow-hidden rounded-lg border">
            <div className="flex h-16">
              {(themes.length > 0 ? themes.map((theme) => theme.id) : [null]).map((theme) => (
                <div
                  key={theme ?? "*"}
                  className="flex-1"
                  style={{ background: colorValue(token, theme) }}
                />
              ))}
            </div>
            <div className="flex flex-col gap-1 p-3 text-xs">
              <span className="font-mono text-sm text-foreground">{token.name}</span>
              <span className="font-mono text-muted-foreground">
                {themes.length > 0 && !token.values["*"]
                  ? themes.map((theme) => colorValue(token, theme.id)).join(" · ")
                  : colorValue(token, null)}
              </span>
              {token.usage ? <span className="text-muted-foreground">{token.usage}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function TypeSection(props: {
  readonly tokens: DesignTokens;
  readonly theme: string | null;
  readonly fontStylesheet: string | null;
}) {
  return (
    <>
      <SectionTitle>Typography</SectionTitle>
      {props.tokens.typeGroups.map((group) => (
        <section key={group.name} className="flex flex-col gap-1">
          <h3 className="text-sm font-medium text-muted-foreground">{group.name}</h3>
          {group.styles.map((style) => (
            <div key={style.name} className="flex flex-col gap-1 border-b py-3">
              <iframe
                title={style.name}
                sandbox={PREVIEW_SANDBOX}
                srcDoc={typeSpecimenDocument(
                  style,
                  props.tokens,
                  props.theme,
                  props.fontStylesheet,
                )}
                className="block w-full border-0"
                style={{ height: `calc(${style.lineHeight} + 16px)`, minHeight: 32 }}
              />
              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{style.name}</span>
                <span>
                  {style.fontSize} / {style.lineHeight} · {style.fontWeight}
                  {style.letterSpacing ? ` · ${style.letterSpacing}` : ""}
                </span>
                {style.usage ? <span>{style.usage}</span> : null}
              </div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

function TokenRows(props: {
  readonly title: string;
  readonly tokens: DesignTokens["spacing"];
  readonly children: (value: string) => ReactNode;
}) {
  return (
    <>
      <SectionTitle>{props.title}</SectionTitle>
      <div className="flex flex-col">
        {props.tokens.map((token) => (
          <div key={token.name} className="flex items-center gap-6 border-b py-4">
            <div className="flex w-32 shrink-0 items-center">{props.children(token.value)}</div>
            <div className="flex min-w-0 flex-col gap-0.5 text-xs">
              <span className="font-mono text-sm">
                {token.name} <span className="text-muted-foreground">{token.value}</span>
              </span>
              {token.usage ? <span className="text-muted-foreground">{token.usage}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ComponentsSection(
  props: ArtifactViewProps & {
    readonly dirs: ReadonlyArray<string>;
    readonly css: string;
    readonly isPending: boolean;
  },
) {
  if (props.dirs.length === 0) {
    return props.isPending ? (
      <PanelSpinner />
    ) : (
      <p className="text-sm text-muted-foreground">This design system has no components.</p>
    );
  }
  return (
    <>
      <SectionTitle>Components</SectionTitle>
      {props.dirs.map((dir) => (
        <ComponentCard key={dir} {...props} dir={dir} />
      ))}
    </>
  );
}

function ComponentCard(props: ArtifactViewProps & { readonly dir: string; readonly css: string }) {
  const readme = useArtifactText(props, `${props.dir}/README.md`);
  const name = props.dir.split("/").pop() ?? props.dir;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-medium">{name}</h3>
      <ComponentPreview {...props} framed />
      {readme ? (
        <ChatMarkdown
          text={readme.replace(/^#\s+[^\n]*\n+/, "")}
          cwd={props.cwd}
          threadRef={props.threadRef}
          className="text-sm"
        />
      ) : null}
    </section>
  );
}

function ComponentPreview(
  props: ArtifactViewProps & {
    readonly dir: string;
    readonly css: string;
    readonly framed: boolean;
  },
) {
  const html = useArtifactText(props, `${props.dir}/preview.html`);
  const boxRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState<number | null>(null);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    return observeResize(box, () => setBoxWidth(box.clientWidth));
  }, [html]);
  if (!html) return html === undefined ? <PanelSpinner /> : null;
  const card = readPreviewCard(html);
  const height = card.height ?? 240;
  // A preview drawn at a fixed width (a cover) scales down to fit, like an image.
  const fixedWidth = previewFixedWidth(html);
  const scale = fixedWidth && boxWidth && boxWidth < fixedWidth ? boxWidth / fixedWidth : 1;
  return (
    <div
      ref={boxRef}
      className={cn("overflow-hidden", props.framed && "rounded-lg border")}
      style={{ height: height * scale }}
    >
      <iframe
        title={props.dir.split("/").pop() ?? "Preview"}
        sandbox={PREVIEW_SANDBOX}
        srcDoc={previewDocument(html, props.css)}
        className="block origin-top-left border-0"
        style={{
          width: scale < 1 ? fixedWidth! : "100%",
          height,
          transform: scale < 1 ? `scale(${scale})` : undefined,
        }}
      />
    </div>
  );
}
