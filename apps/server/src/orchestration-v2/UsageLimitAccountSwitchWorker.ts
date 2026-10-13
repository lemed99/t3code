import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProviderInstanceId,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** How long an account that failed without a reported reset is skipped. */
export const UNKNOWN_RESET_BACKOFF_MS = 60 * 60 * 1000;

type SwitchCandidateProvider = Pick<
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

function spentUntil(provider: Pick<ServerProvider, "usageLimits">, nowMs: number): number | null {
  let until: number | null = null;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.usedPercent < 100) continue;
    const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
    // A spent window with no reset promises nothing, so it blocks for now.
    const windowUntil = Number.isFinite(resetMs) ? resetMs : Number.POSITIVE_INFINITY;
    if (windowUntil <= nowMs) continue;
    until = Math.max(until ?? 0, windowUntil);
  }
  return until;
}

function peakUsedPercent(provider: Pick<ServerProvider, "usageLimits">): number {
  return (provider.usageLimits?.windows ?? []).reduce(
    (peak, window) => Math.max(peak, window.usedPercent),
    0,
  );
}

/**
 * Another account of the same driver that can take over a limited thread.
 * Accounts sharing the thread's continuation group resume natively, so they
 * win over ones that need a context handoff; then the most headroom wins.
 */
export function selectAccountSwitchTarget<Provider extends SwitchCandidateProvider>(input: {
  readonly providers: ReadonlyArray<Provider>;
  readonly fromInstanceId: ProviderInstanceId;
  readonly nowMs: number;
  readonly limitedUntil: ReadonlyMap<ProviderInstanceId, number>;
  /** The user's switch order; the first listed account with usage left wins. */
  readonly order?: ReadonlyArray<string>;
}): Provider | null {
  const from = input.providers.find((provider) => provider.instanceId === input.fromInstanceId);
  if (!from) return null;
  const sharesSession = (provider: Provider) =>
    provider.continuation?.groupKey === from.continuation?.groupKey;
  const order = input.order ?? [];
  const rank = (provider: Provider) => {
    const index = order.indexOf(provider.instanceId);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const better = (candidate: Provider, current: Provider) =>
    rank(candidate) !== rank(current)
      ? rank(candidate) < rank(current)
      : sharesSession(candidate) !== sharesSession(current)
        ? sharesSession(candidate)
        : peakUsedPercent(candidate) < peakUsedPercent(current);
  let best: Provider | null = null;
  for (const candidate of input.providers) {
    if (candidate.instanceId === from.instanceId || candidate.driver !== from.driver) continue;
    if (!candidate.enabled || !candidate.installed) continue;
    if (candidate.availability === "unavailable") continue;
    if (candidate.status === "error" || candidate.status === "disabled") continue;
    if (candidate.auth.status === "unauthenticated") continue;
    if ((input.limitedUntil.get(candidate.instanceId) ?? 0) > input.nowMs) continue;
    if (spentUntil(candidate, input.nowMs) !== null) continue;
    if (best === null || better(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * Until when the account a limited run failed on stays limited, or null once
 * the limit has passed and ordinary limit recovery owns the thread. A limit
 * with no reported reset counts for a fixed backoff from the failure.
 */
export function limitedThroughMs(
  thread: Pick<
    ProjectionStore.ProjectionAccountSwitchCandidate,
    "usageLimitResetAt" | "latestRunCompletedAt"
  >,
  nowMs: number,
): number | null {
  const resetMs =
    thread.usageLimitResetAt === null ? Number.NaN : Date.parse(thread.usageLimitResetAt);
  const until = Number.isFinite(resetMs)
    ? resetMs
    : thread.latestRunCompletedAt === null
      ? nowMs + UNKNOWN_RESET_BACKOFF_MS
      : DateTime.toEpochMillis(thread.latestRunCompletedAt) + UNKNOWN_RESET_BACKOFF_MS;
  return until > nowMs ? until : null;
}

/**
 * The commands that continue a limited run on `target`: the same "continue"
 * message the resume button sends, bound to the other account, then a queue
 * release when messages were held behind the limit. Ids derive from the
 * limited run so a repeated sweep replays the same receipts.
 */
export function accountSwitchCommands(
  limited: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly modelSelection: ModelSelection;
    readonly hasHeldQueuedRuns: boolean;
  },
  target: ProviderInstanceId,
): ReadonlyArray<OrchestrationV2Command> {
  const identity = `${limited.threadId}:${limited.runId}:${target}`;
  const continueCommand: OrchestrationV2Command = {
    type: "message.dispatch",
    commandId: CommandId.make(`account-switch:${identity}`),
    messageId: MessageId.make(`account-switch:${identity}`),
    threadId: limited.threadId,
    manualContinuationOfRunId: limited.runId,
    modelSelection: { ...limited.modelSelection, instanceId: target },
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
  if (!limited.hasHeldQueuedRuns) return [continueCommand];
  return [
    continueCommand,
    {
      type: "queue.resume",
      commandId: CommandId.make(`account-switch-queue:${identity}`),
      threadId: limited.threadId,
    },
  ];
}

/** How long a paused run may take to stop before its switch is abandoned. */
const INTERRUPT_SETTLE_MS = 5 * 60 * 1000;

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  // Snapshots can lag a fresh limit, so the account a run just failed on is
  // remembered until its reset even when its usage windows still look open.
  const limitedUntil = new Map<ProviderInstanceId, number>();
  // One switch attempt per limited run; a rejected switch falls back to
  // ordinary limit recovery instead of retrying every tick.
  const attemptedRuns = new Set<string>();
  // Paused runs this worker interrupted, continued on `target` once stopped.
  // Only runs interrupted here continue: a user's own Stop stays a stop.
  const interrupted = new Map<
    RunId,
    {
      readonly threadId: ThreadId;
      readonly modelSelection: ModelSelection;
      readonly target: ProviderInstanceId;
      readonly interruptedAtMs: number;
    }
  >();

  const dispatchAll = (
    commands: ReadonlyArray<OrchestrationV2Command>,
    log: { readonly threadId: ThreadId; readonly toInstanceId: ProviderInstanceId },
  ) =>
    Effect.forEach(commands, (command) => threads.dispatch(command)).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.account-switch.dispatch-failed", {
          ...log,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  const pickTarget = (
    providers: ReadonlyArray<ServerProvider>,
    from: ProviderInstanceId,
    nowMs: number,
    order: ReadonlyArray<string>,
  ) => selectAccountSwitchTarget({ providers, fromInstanceId: from, nowMs, limitedUntil, order });

  const markLimited = (instanceId: ProviderInstanceId, until: number) => {
    if ((limitedUntil.get(instanceId) ?? 0) < until) limitedUntil.set(instanceId, until);
  };

  return Effect.fn("UsageLimitAccountSwitchWorker.sweep")(function* () {
    const current = yield* settings.getSettings;
    if (!current.autoSwitchAccountOnUsageLimit) return;
    const order = current.accountSwitchOrder;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const [instanceId, until] of limitedUntil) {
      if (until <= nowMs) limitedUntil.delete(instanceId);
    }

    // 1. Runs interrupted on an earlier tick continue once they have stopped.
    for (const [runId, pending] of interrupted) {
      const shell = yield* projections.getThreadShell(pending.threadId);
      if (shell === null || shell.latestRunId !== runId) {
        interrupted.delete(runId);
        continue;
      }
      if (shell.status === "running" || shell.status === "waiting") {
        if (nowMs - pending.interruptedAtMs > INTERRUPT_SETTLE_MS) interrupted.delete(runId);
        continue;
      }
      interrupted.delete(runId);
      if (shell.status !== "interrupted") continue;
      yield* dispatchAll(
        accountSwitchCommands(
          {
            threadId: pending.threadId,
            runId,
            modelSelection: pending.modelSelection,
            hasHeldQueuedRuns: false,
          },
          pending.target,
        ),
        { threadId: pending.threadId, toInstanceId: pending.target },
      );
    }

    const failed = yield* projections.getAccountSwitchCandidates();
    const held = yield* projections.getHeldUsageLimitRuns();
    if (failed.length === 0 && held.length === 0) return;
    const providers = yield* providerRegistry.getProviders;

    // 2. Runs that ended on a usage limit continue on another account now.
    for (const thread of failed) {
      // The user picked another account after the limit; leave it to them.
      if (thread.modelSelection.instanceId !== thread.runProviderInstanceId) continue;
      const attempt = `${thread.id}:${thread.latestRunId}`;
      if (attemptedRuns.has(attempt)) continue;
      const limitedFor = limitedThroughMs(thread, nowMs);
      if (limitedFor === null) continue;
      markLimited(thread.runProviderInstanceId, limitedFor);
      const target = pickTarget(providers, thread.runProviderInstanceId, nowMs, order);
      if (target === null) continue;
      attemptedRuns.add(attempt);
      const switched = yield* dispatchAll(
        accountSwitchCommands(
          {
            threadId: thread.id,
            runId: thread.latestRunId,
            modelSelection: thread.modelSelection,
            hasHeldQueuedRuns: thread.hasHeldQueuedRuns,
          },
          target.instanceId,
        ),
        { threadId: thread.id, toInstanceId: target.instanceId },
      );
      if (switched) {
        yield* Effect.logInfo("orchestration-v2.account-switch.switched", {
          threadId: thread.id,
          fromInstanceId: thread.runProviderInstanceId,
          toInstanceId: target.instanceId,
        });
      }
    }

    // 3. Runs the provider paused on a rejected window are stopped first; a
    // later tick continues them (step 1).
    for (const run of held) {
      if (run.modelSelection.instanceId !== run.runProviderInstanceId) continue;
      const attempt = `${run.id}:${run.runId}`;
      if (attemptedRuns.has(attempt)) continue;
      const from = providers.find((provider) => provider.instanceId === run.runProviderInstanceId);
      const spent = from === undefined ? null : spentUntil(from, nowMs);
      markLimited(
        run.runProviderInstanceId,
        spent !== null && Number.isFinite(spent) ? spent : nowMs + UNKNOWN_RESET_BACKOFF_MS,
      );
      const target = pickTarget(providers, run.runProviderInstanceId, nowMs, order);
      if (target === null) continue;
      attemptedRuns.add(attempt);
      const stopped = yield* dispatchAll(
        [
          {
            type: "run.interrupt",
            commandId: CommandId.make(`account-switch-interrupt:${run.id}:${run.runId}`),
            threadId: run.id,
            runId: run.runId,
            reason: "Usage limit reached. Continuing on another account.",
          },
        ],
        { threadId: run.id, toInstanceId: target.instanceId },
      );
      if (stopped) {
        interrupted.set(run.runId, {
          threadId: run.id,
          modelSelection: run.modelSelection,
          target: target.instanceId,
          interruptedAtMs: nowMs,
        });
      }
    }
  });
});

// Runs on the shared scheduler next to limit recovery: a limited thread moves
// to an account with usage left, and recovery only waits when none has any.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-account-switch", sweep());
  }),
);
