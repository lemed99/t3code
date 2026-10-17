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
