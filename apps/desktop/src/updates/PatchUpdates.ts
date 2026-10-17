// @effect-diagnostics nodeBuiltinImport:off -- The installer must outlive T3 Code (it installs once the app quits), which Effect's scoped child processes do not allow.
import * as NodeChildProcess from "node:child_process";

import type { DesktopPatchUpdateState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

/**
 * Updates for a patched build, installed by scripts/t3code-auto/install.command
 * into ~/t3code-auto. The installer names the fork and branch it builds from;
 * this reads them there, so the app needs no address of its own.
 */

type Run = NonNullable<DesktopPatchUpdateState["run"]>;
type Phase = Run["phase"];

const PHASES: ReadonlySet<string> = new Set<Phase>([
  "checking",
  "downloading",
  "building",
  "ready",
  "installing",
  "installed",
  "up-to-date",
  "failed",
]);
const FINISHED: ReadonlySet<Phase> = new Set(["installed", "up-to-date", "failed"]);

/** The fork and branch an installer builds from, or null when it names none. */
export function installerSource(
  script: string,
): { readonly owner: string; readonly branch: string } | null {
  const owner = /^FORK_OWNER="([A-Za-z0-9-]+)"$/m.exec(script)?.[1];
  const branch = /^BRANCH="([A-Za-z0-9._/-]+)"$/m.exec(script)?.[1];
  return owner && branch ? { owner, branch } : null;
}

/**
 * The installer's last status. A run whose process is gone mid-way stopped
 * without saying so (the Mac slept through it, or it was killed).
 */
export function runFromStatus(json: string, processAlive: (pid: number) => boolean): Run | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { phase, message, pid, at } = value as Record<string, unknown>;
  if (typeof phase !== "string" || !PHASES.has(phase) || typeof message !== "string") return null;
  const finished = FINISHED.has(phase as Phase);
  const alive = typeof pid === "number" && processAlive(pid);
  if (!finished && !alive) {
    return {
      phase: "failed",
      message: "The last update stopped before it finished.",
      active: false,
      at: typeof at === "number" ? at : 0,
    };
  }
  return {
    phase: phase as Phase,
    message,
    active: !finished,
    at: typeof at === "number" ? at : 0,
  };
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive but owned by someone else still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const LatestCommit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    committer: Schema.optional(
      Schema.NullOr(Schema.Struct({ date: Schema.optional(Schema.String) })),
    ),
  }),
});

export class PatchUpdates extends Context.Service<
  PatchUpdates,
  {
    readonly state: Effect.Effect<DesktopPatchUpdateState>;
    readonly check: Effect.Effect<DesktopPatchUpdateState>;
    readonly start: Effect.Effect<DesktopPatchUpdateState>;
    readonly restartToInstall: Effect.Effect<void>;
  }
>()("@t3tools/desktop/updates/PatchUpdates") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const path = environment.path;
  const base = path.join(environment.homeDirectory, "t3code-auto");
  const installer = path.join(base, "tools", "install.command");
  const supported = environment.platform === "darwin" && environment.isPackaged;
  const latestRef = yield* Ref.make<DesktopPatchUpdateState["latest"]>(null);
  const checkErrorRef = yield* Ref.make<string | null>(null);

  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));

  const source = Effect.gen(function* () {
    if (!supported) return null;
    const script = yield* readText(installer);
    return script === null ? null : installerSource(script);
  });

  const state = Effect.gen(function* () {
    const from = yield* source;
    const installed = (yield* readText(path.join(base, "installed-version")))?.trim() || null;
    const status = yield* readText(path.join(base, "status.json"));
    return {
      supported: from !== null,
      source: from === null ? null : `${from.owner}/t3code@${from.branch}`,
      installedVersion: installed,
      latest: yield* Ref.get(latestRef),
      checkError: yield* Ref.get(checkErrorRef),
      run: status === null ? null : runFromStatus(status, processAlive),
    } satisfies DesktopPatchUpdateState;
  });

  const check = Effect.gen(function* () {
    const from = yield* source;
    if (from === null) return yield* state;
    const latest = yield* http
      .execute(
        HttpClientRequest.get(
          `https://api.github.com/repos/${from.owner}/t3code/commits/${encodeURIComponent(from.branch)}`,
        ).pipe(HttpClientRequest.setHeader("accept", "application/vnd.github+json")),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(LatestCommit)),
        Effect.map((body) => ({
          version: body.sha,
          date: body.commit.committer?.date ?? null,
          summary: body.commit.message.split("\n", 1)[0] ?? "",
        })),
        Effect.timeout("15 seconds"),
        Effect.option,
      );
    if (latest._tag === "Some") {
      yield* Ref.set(latestRef, latest.value);
      yield* Ref.set(checkErrorRef, null);
    } else {
      yield* Ref.set(checkErrorRef, "Couldn't reach GitHub to check for a new version.");
    }
    return yield* state;
  });

  const start = Effect.gen(function* () {
    const current = yield* state;
    if (!current.supported || current.run?.active) return current;
    yield* Effect.sync(() => {
      // Detached, so a build keeps going when T3 Code quits to install it.
      const child = NodeChildProcess.spawn(
        "/bin/bash",
        [
          "-c",
          'exec /bin/bash "$0" --unattended --relaunch >>"$1" 2>&1',
          installer,
          path.join(base, "update.log"),
        ],
        { detached: true, stdio: "ignore", env: process.env },
      );
      child.unref();
    });
    return yield* state;
  });

  return PatchUpdates.of({
    state,
    check,
    start,
    // The installer waits for T3 Code to close, installs, then reopens it.
    restartToInstall: electronApp.quit,
  });
});

export const layer = Layer.effect(PatchUpdates, make);
