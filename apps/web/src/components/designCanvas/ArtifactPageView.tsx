import { FileCode2 } from "lucide-react";
import { useMemo } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";

import { workspaceAssetResource } from "../files/filePreviewMode";
import {
  ArtifactHeader,
  type ArtifactViewProps,
  PanelSpinner,
  ToolbarButton,
} from "./artifactChrome";
import { screenFrameSrc } from "./designCanvas.logic";

/**
 * A web page or small app made as an artifact: it fills the panel and works
 * like a page in a browser (scrolls, takes clicks and input), in a sandboxed
 * frame with an opaque origin.
 */
export function ArtifactPageView(props: ArtifactViewProps & { readonly path: string }) {
  const resource = useMemo(
    () =>
      workspaceAssetResource({
        kind: "workspace-file",
        threadRef: props.threadRef,
        draft: props.draft,
        workspaceRoot: props.cwd,
        // Relative, so the page's own scripts, styles and images beside it load.
        absolutePath: props.path,
      }),
    [props.threadRef, props.draft, props.cwd, props.path],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactHeader picker={props.picker} onReload={props.onReload}>
        <ToolbarButton label="Open file" onClick={() => props.onOpenFile(props.path)}>
          <FileCode2 />
        </ToolbarButton>
      </ArtifactHeader>
      {assetUrl._tag === "Success" ? (
        <iframe
          key={props.designRevision ?? ""}
          src={screenFrameSrc(assetUrl.url, props.path, props.designRevision)}
          title={props.path}
          sandbox="allow-scripts allow-forms allow-popups allow-downloads"
          className="block min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : assetUrl._tag === "Failure" ? (
        <p className="p-6 text-sm text-muted-foreground">Couldn't load {props.path}</p>
      ) : (
        <PanelSpinner />
      )}
    </div>
  );
}
