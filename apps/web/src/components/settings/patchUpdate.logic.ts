import type { DesktopPatchUpdateState } from "@t3tools/contracts";

export type PatchUpdateAction = "check" | "update" | "restart" | "none";

const short = (version: string) => version.slice(0, 7);

/** What the Patch updates row says and offers for the installer's state. */
export function patchUpdateView(state: DesktopPatchUpdateState): {
  readonly description: string;
  readonly action: PatchUpdateAction;
  readonly label: string;
  /** A second button, beside the main one. */
  readonly secondary?: { readonly action: PatchUpdateAction; readonly label: string };
} {
  const run = state.run;
  if (run?.active) {
    if (run.phase !== "ready") {
      return { description: run.message, action: "none", label: "Updating…" };
    }
    const staged = run.version ?? null;
    const latest = state.latest;
    // A build waits for a restart; the branch may have moved on meanwhile.
    if (staged !== null && latest !== null && latest.version !== staged) {
      return {
        description: `Ready to install ${short(staged)}, but a newer version is out: ${latest.summary} (${short(latest.version)}).`,
        action: "update",
        label: "Build Newer Version",
        secondary: { action: "restart", label: "Install Ready One" },
      };
    }
    return {
      description:
        staged !== null && latest !== null
          ? `${run.message} It is the latest (${short(staged)}).`
          : run.message,
      action: "restart",
      label: "Restart to Install",
      secondary: { action: "check", label: "Check for Updates" },
    };
  }
  const installed = state.installedVersion;
  const latest = state.latest;
  const installedText = installed ? `Installed ${short(installed)}.` : "Installed version unknown.";
  if (run?.phase === "failed" && (latest === null || latest.version !== installed)) {
    return { description: `${run.message} ${installedText}`, action: "update", label: "Try Again" };
  }
  if (latest !== null && latest.version !== installed) {
    return {
      description: `${installedText} New: ${latest.summary} (${short(latest.version)}).`,
      action: "update",
      label: "Update",
    };
  }
  // The installer checks the branch itself (over git) and stops when
  // nothing is new, so a failed check never blocks an update.
  if (state.checkError) {
    return {
      description: `${state.checkError} ${installedText} Update checks with git instead.`,
      action: "update",
      label: "Update",
    };
  }
  return {
    description:
      latest === null
        ? `${installedText} Updates come from ${state.source}.`
        : `Up to date (${short(latest.version)}).`,
    action: "check",
    label: "Check for Updates",
  };
}
