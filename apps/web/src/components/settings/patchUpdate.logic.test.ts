import type { DesktopPatchUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { patchUpdateView } from "./patchUpdate.logic";

const base: DesktopPatchUpdateState = {
  supported: true,
  source: "lemed99/t3code@auto-account-switch",
  installedVersion: "aaaaaaa1111",
  latest: null,
  checkError: null,
  run: null,
};
const latest = { version: "bbbbbbb2222", date: null, summary: "Fix account switching" };

describe("patchUpdateView", () => {
  it("offers an update when the branch has moved on", () => {
    expect(patchUpdateView({ ...base, latest })).toMatchObject({
      action: "update",
      description: "Installed aaaaaaa. New: Fix account switching (bbbbbbb).",
    });
  });

  it("says up to date when the installed version is the latest", () => {
    expect(
      patchUpdateView({ ...base, latest: { ...latest, version: base.installedVersion! } }),
    ).toMatchObject({ action: "check", description: "Up to date (aaaaaaa)." });
  });

  it("shows progress while building, and a restart once the build is ready", () => {
    const run = { message: "Building", active: true, at: 1 };
    expect(patchUpdateView({ ...base, run: { ...run, phase: "building" } }).action).toBe("none");
    expect(patchUpdateView({ ...base, run: { ...run, phase: "ready" } }).action).toBe("restart");
  });

  it("lets a ready build be checked against the branch, and replaced by a newer one", () => {
    const ready = {
      phase: "ready" as const,
      message: "Ready. It installs when you restart T3 Code.",
      active: true,
      at: 1,
      version: "ccccccc3333",
    };
    expect(patchUpdateView({ ...base, run: ready })).toMatchObject({
      action: "restart",
      secondary: { action: "check" },
    });
    expect(
      patchUpdateView({ ...base, run: ready, latest: { ...latest, version: ready.version } }),
    ).toMatchObject({ action: "restart", secondary: { action: "check" } });
    expect(patchUpdateView({ ...base, run: ready, latest })).toMatchObject({
      action: "update",
      label: "Build Newer Version",
      secondary: { action: "restart" },
    });
  });

  it("still offers an update when GitHub cannot be checked", () => {
    expect(
      patchUpdateView({
        ...base,
        checkError: "Couldn't check GitHub for a new version (GitHub answered 403).",
      }),
    ).toMatchObject({ action: "update", label: "Update" });
  });

  it("lets a failed update be retried", () => {
    expect(
      patchUpdateView({
        ...base,
        latest,
        run: { phase: "failed", message: "Downloads timed out.", active: false, at: 1 },
      }),
    ).toMatchObject({ action: "update", label: "Try Again" });
  });
});
