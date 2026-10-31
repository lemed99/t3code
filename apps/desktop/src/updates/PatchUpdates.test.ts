// @effect-diagnostics nodeBuiltinImport:off -- The test reads the shipped installer script.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { installerSource, runFromStatus, startedStatus } from "./PatchUpdates.ts";

const status = (value: Record<string, unknown>) => JSON.stringify(value);

describe("installerSource", () => {
  it("reads the fork and branch the installer builds from", () => {
    expect(installerSource('FORK_OWNER="someone"\nBRANCH="auto-account-switch"\n')).toEqual({
      owner: "someone",
      branch: "auto-account-switch",
    });
  });

  it("builds the shipped installer from the fork's patched branch", () => {
    const shipped = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "../../../../scripts/t3code-auto/install.command"),
      "utf8",
    );
    expect(installerSource(shipped)).toEqual({ owner: "lemed99", branch: "auto-account-switch" });
  });
});

describe("startedStatus", () => {
  it("shows an update as running from the moment its installer starts", () => {
    expect(runFromStatus(startedStatus(42, 5), (pid) => pid === 42)).toEqual({
      phase: "checking",
      message: "Checking for a new version",
      active: true,
      at: 5,
    });
  });
});

describe("runFromStatus", () => {
  it("shows a run in progress while its installer is alive", () => {
    expect(
      runFromStatus(
        status({ phase: "building", message: "Building", pid: 42, at: 5 }),
        (pid) => pid === 42,
      ),
    ).toEqual({ phase: "building", message: "Building", active: true, at: 5 });
  });

  it("reports a run whose installer died mid-way as stopped", () => {
    expect(
      runFromStatus(
        status({ phase: "building", message: "Building", pid: 42, at: 5 }),
        () => false,
      ),
    ).toMatchObject({ phase: "failed", active: false });
  });

  it("keeps a finished run's result after its installer exits", () => {
    expect(
      runFromStatus(status({ phase: "installed", message: "Done", pid: 42, at: 5 }), () => false),
    ).toEqual({ phase: "installed", message: "Done", active: false, at: 5 });
  });

  it("ignores a status it cannot read", () => {
    expect(runFromStatus("{", () => true)).toBeNull();
    expect(runFromStatus(status({ phase: "dancing", message: "" }), () => true)).toBeNull();
  });
});
