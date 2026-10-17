import type { DesktopPatchUpdateState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { patchUpdateView } from "./patchUpdate.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// How often a running update's progress is read while this row is open.
const PROGRESS_POLL_MS = 3_000;

/** Updates a patched build from its fork, on desktop installs made by its installer. */
export function PatchUpdateSettingsRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.patchUpdate;
  const [state, setState] = useState<DesktopPatchUpdateState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .check()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const active = state?.run?.active === true;
  useEffect(() => {
    if (!bridge || !active) return;
    const timer = setInterval(() => {
      void bridge
        .getState()
        .then(setState)
        .catch(() => undefined);
    }, PROGRESS_POLL_MS);
    return () => clearInterval(timer);
  }, [bridge, active]);

  if (!bridge || !state?.supported) return null;
  const view = patchUpdateView(state);

  const act = () => {
    if (pending || view.action === "none") return;
    setPending(true);
    const run =
      view.action === "restart"
        ? bridge.restartToInstall().then(() => state)
        : view.action === "update"
          ? bridge.start()
          : bridge.check();
    void run
      .then(setState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Patch update failed",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <SettingsRow
      {...searchableSetting("patch-updates")}
      description={view.description}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={pending || view.action === "none"}
          onClick={act}
        >
          {view.label}
        </Button>
      }
    />
  );
}
