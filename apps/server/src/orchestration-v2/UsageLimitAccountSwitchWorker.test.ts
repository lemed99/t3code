import { assert, it as effectIt } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import {
  UNKNOWN_RESET_BACKOFF_MS,
  limitedThroughMs,
  makeSweep,
  selectAccountSwitchTarget,
} from "./UsageLimitAccountSwitchWorker.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const claude = ProviderDriverKind.make("claudeAgent");

function account(
  id: string,
  overrides: Partial<Parameters<typeof selectAccountSwitchTarget>[0]["providers"][number]> = {},
) {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: claude,
    continuation: { groupKey: `claude:projects:/home/me/.${id}/projects` },
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    availability: "available",
    ...overrides,
  } satisfies Pick<
    ServerProvider,
    | "instanceId"
    | "driver"
    | "continuation"
    | "enabled"
    | "installed"
    | "status"
    | "auth"
    | "availability"
    | "usageLimits"
  >;
}

function usage(usedPercent: number, resetsAt = "2026-10-09T15:00:00.000Z") {
  return {
    usageLimits: {
      checkedAt: "2026-10-09T11:59:00.000Z",
      windows: [{ id: "session", kind: "session", label: "Session", usedPercent, resetsAt }],
    },
  } as const;
}

const select = (
  providers: ReadonlyArray<ReturnType<typeof account>>,
  limitedUntil = new Map<ProviderInstanceId, number>(),
  order: ReadonlyArray<string> = [],
) =>
  selectAccountSwitchTarget({
    providers,
    fromInstanceId: ProviderInstanceId.make("max"),
    nowMs: NOW,
    limitedUntil,
    order,
  })?.instanceId ?? null;

describe("selectAccountSwitchTarget", () => {
  it("skips accounts that cannot run a turn", () => {
    expect(
      select([
        account("max"),
        account("codex", { driver: ProviderDriverKind.make("codex") }),
        account("off", { enabled: false }),
        account("broken", { status: "error" }),
        account("signedOut", { auth: { status: "unauthenticated" } }),
        account("gone", { availability: "unavailable" }),
        account("spent", usage(100)),
      ]),
    ).toBeNull();
  });

  it("prefers accounts that share the thread's session store, then the most headroom", () => {
    const shared = { continuation: { groupKey: "claude:projects:/home/me/.claude/projects" } };
    expect(
      select([
        account("max", shared),
        account("team1", usage(10)),
        account("team2", { ...shared, ...usage(80) }),
        account("team3", { ...shared, ...usage(40) }),
      ]),
    ).toBe("team3");
  });

  it("follows the user's order first, skipping accounts with no usage left", () => {
    const providers = [
      account("max"),
      account("team1", usage(10)),
      account("team2", usage(100)),
      account("team3", usage(70)),
    ];
    expect(select(providers, new Map(), ["team2", "team3", "team1"])).toBe("team3");
    // Unlisted accounts come after the listed ones.
    expect(select(providers, new Map(), ["team3"])).toBe("team3");
    expect(select([account("max"), account("team1"), account("team4")], new Map(), ["team4"])).toBe(
      "team4",
    );
  });

  it("treats a spent window whose reset has passed as open again", () => {
    expect(select([account("max"), account("team1", usage(100, "2026-10-09T11:00:00.000Z"))])).toBe(
      "team1",
    );
  });

  it("skips an account that just failed even when its snapshot still looks open", () => {
    const limitedUntil = new Map([[ProviderInstanceId.make("team1"), NOW + 60_000]]);
    expect(select([account("max"), account("team1"), account("team2")], limitedUntil)).toBe(
      "team2",
    );
  });
});

describe("limitedThroughMs", () => {
  it("uses the reported reset while it is in the future", () => {
    const resetAt = "2026-10-09T14:00:00.000Z";
    expect(limitedThroughMs({ usageLimitResetAt: resetAt, latestRunCompletedAt: null }, NOW)).toBe(
      Date.parse(resetAt),
    );
  });

  it("leaves limits whose reset has passed to ordinary recovery", () => {
    expect(
      limitedThroughMs(
        { usageLimitResetAt: "2026-10-09T11:00:00.000Z", latestRunCompletedAt: null },
        NOW,
      ),
    ).toBeNull();
  });

  it("backs off from the failure when no reset was reported", () => {
    const completedAt = DateTime.makeUnsafe(NOW - 60_000);
    expect(
      limitedThroughMs({ usageLimitResetAt: null, latestRunCompletedAt: completedAt }, NOW),
    ).toBe(NOW - 60_000 + UNKNOWN_RESET_BACKOFF_MS);
    expect(
      limitedThroughMs(
        {
          usageLimitResetAt: null,
          latestRunCompletedAt: DateTime.makeUnsafe(NOW - UNKNOWN_RESET_BACKOFF_MS - 1),
        },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("account switch sweep", () => {
  const max = ProviderInstanceId.make("max");
  const limitedThread = {
    id: ThreadId.make("thread"),
    latestRunId: RunId.make("run"),
    latestRunCompletedAt: null,
    runProviderInstanceId: max,
    modelSelection: { instanceId: max, model: "claude-opus-5-5" },
    usageLimitResetAt: "2026-10-09T15:00:00.000Z",
    hasHeldQueuedRuns: false,
  } satisfies ProjectionStore.ProjectionAccountSwitchCandidate;

  const runSweeps = (input: {
    readonly enabled: boolean;
    readonly providers: ReadonlyArray<ReturnType<typeof account>>;
    readonly times: number;
    readonly failed?: ReadonlyArray<ProjectionStore.ProjectionAccountSwitchCandidate>;
    readonly held?: Ref.Ref<ReadonlyArray<ProjectionStore.ProjectionHeldUsageLimitRun>>;
    readonly shellStatus?: Ref.Ref<OrchestrationV2ThreadShell["status"]>;
  }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const dispatched = yield* Ref.make<
        ReadonlyArray<
          Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0]
        >
      >([]);
      const layer = Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getAccountSwitchCandidates: () => Effect.succeed(input.failed ?? [limitedThread]),
          getHeldUsageLimitRuns: () =>
            input.held === undefined ? Effect.succeed([]) : Ref.get(input.held),
          getThreadShell: () =>
            Effect.gen(function* () {
              if (input.shellStatus === undefined) return null;
              return {
                latestRunId: RunId.make("paused"),
                status: yield* Ref.get(input.shellStatus),
              } as OrchestrationV2ThreadShell;
            }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            autoSwitchAccountOnUsageLimit: input.enabled,
          }),
        }),
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed(input.providers as unknown as ReadonlyArray<ServerProvider>),
        }),
      );
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        for (let index = 0; index < input.times; index++) {
          yield* sweep();
          // Between ticks the provider stops the interrupted run.
          if (input.shellStatus !== undefined && input.held !== undefined) {
            const pending = (yield* Ref.get(dispatched)).some(
              (command) => command.type === "run.interrupt",
            );
            if (pending) {
              yield* Ref.set(input.held, []);
              yield* Ref.set(input.shellStatus, "interrupted");
            }
          }
        }
      }).pipe(Effect.provide(layer));
      return yield* Ref.get(dispatched);
    });

  effectIt.effect("moves a limited thread to the account with usage left, once", () =>
    Effect.gen(function* () {
      const commands = yield* runSweeps({
        enabled: true,
        providers: [account("max"), account("team1", usage(100)), account("team2")],
        times: 3,
      });
      assert.lengthOf(commands, 1);
      const [command] = commands;
      assert.equal(command?.type, "message.dispatch");
      if (command?.type !== "message.dispatch") return;
      assert.equal(command.modelSelection?.instanceId, "team2");
      assert.equal(command.manualContinuationOfRunId, limitedThread.latestRunId);
    }),
  );

  effectIt.effect("does nothing while the setting is off or no account has usage left", () =>
    Effect.gen(function* () {
      assert.lengthOf(
        yield* runSweeps({
          enabled: false,
          providers: [account("max"), account("team1")],
          times: 1,
        }),
        0,
      );
      assert.lengthOf(
        yield* runSweeps({
          enabled: true,
          providers: [account("max"), account("team1", usage(100))],
          times: 1,
        }),
        0,
      );
    }),
  );

  effectIt.effect("stops a run the provider paused on a limit, then continues it elsewhere", () =>
    Effect.gen(function* () {
      const paused = {
        id: limitedThread.id,
        runId: RunId.make("paused"),
        runProviderInstanceId: max,
        modelSelection: limitedThread.modelSelection,
      } satisfies ProjectionStore.ProjectionHeldUsageLimitRun;
      const commands = yield* runSweeps({
        enabled: true,
        providers: [account("max", usage(100)), account("team1")],
        times: 3,
        failed: [],
        held: yield* Ref.make<ReadonlyArray<ProjectionStore.ProjectionHeldUsageLimitRun>>([paused]),
        shellStatus: yield* Ref.make<OrchestrationV2ThreadShell["status"]>("running"),
      });
      assert.deepEqual(
        commands.map((command) => command.type),
        ["run.interrupt", "message.dispatch"],
      );
      const continuation = commands[1];
      if (continuation?.type !== "message.dispatch") return;
      assert.equal(continuation.modelSelection?.instanceId, "team1");
      assert.equal(continuation.manualContinuationOfRunId, paused.runId);
    }),
  );
});
