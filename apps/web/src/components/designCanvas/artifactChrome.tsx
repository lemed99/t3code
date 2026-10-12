import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Frame } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** Shared pieces of the Artifacts panel's views. */

export interface DesignCanvasPanelProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  /** The thread is a draft the server does not know yet. */
  readonly draft: boolean;
  /** Changes when the agent may have changed design files; reloads the screens. */
  readonly designRevision: string | null;
  readonly onOpenFile: (relativePath: string) => void;
}

export interface ArtifactViewProps extends DesignCanvasPanelProps {
  readonly onReload: () => void;
  readonly picker: ReactNode;
}

export function PanelSpinner() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <Spinner size="lg" />
    </div>
  );
}

export function PanelEmpty(props: { readonly title: string; readonly description: string }) {
  return (
    <Empty className="min-h-0 flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Frame />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** The bar above every artifact: which one is open, and its actions. */
export function ArtifactHeader(props: {
  readonly picker: ReactNode;
  readonly onReload: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-1">
      <div className="flex min-w-0 items-center">{props.picker}</div>
      <div className="flex shrink-0 items-center gap-0.5">
        {props.children}
        <ToolbarButton label="Reload" onClick={props.onReload}>
          <RefreshIcon />
        </ToolbarButton>
      </div>
    </div>
  );
}

export function ToolbarButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={props.label} onClick={props.onClick} />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}
