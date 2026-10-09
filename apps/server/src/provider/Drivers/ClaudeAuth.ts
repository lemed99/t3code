import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { ChildProcessSpawner } from "effect/process";

/** The single sign-in method: Claude Code's own `auth login`, in a terminal. */
export const CLAUDE_LOGIN_METHOD_ID = "claude-login";

const TRANSCRIPT_LIMIT = 16_384;

/**
 * Sign-in for one Claude instance, run with that instance's
 * `CLAUDE_CONFIG_DIR` so each account logs into its own directory. The login
 * runs in an in-app terminal because Claude Code's login is interactive.
 */
export const makeClaudeAuth = Effect.fn("makeClaudeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  /** The instance's spawn environment, including its `CLAUDE_CONFIG_DIR`. */
  readonly environment: NodeJS.ProcessEnv;
  readonly configDir: string;
  readonly cwd: string;
  readonly logout: Effect.Effect<
    { readonly code: number },
    ProviderSetupError,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  /** Re-probes the instance; fails when `signedIn` and the probe disagrees. */
  readonly onChanged: (signedIn: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const services = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const failure = (operation: "start" | "respond" | "logout", detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });

  const runLogin = Effect.fnUntraced(function* (context: ProviderAuthFlow.ProviderAuthFlowContext) {
    if (Option.isNone(pty)) {
      return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
    }
    const spawn = yield* resolveSpawnCommand(options.binaryPath, ["auth", "login"], {
      env: options.environment,
    });
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const process = yield* pty.value
      .spawn({
        shell: spawn.command,
        args: [...spawn.args],
        cwd: options.cwd,
        cols: 80,
        rows: 24,
        env: options.environment,
      })
      .pipe(Effect.mapError(() => failure("start", "Could not open the Claude sign-in terminal.")));
    const detachData = process.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-TRANSCRIPT_LIMIT));
    });
    const detachExit = process.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          process.kill();
        } catch {
          /* The login process may already have exited. */
        }
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) process.resize(response.size.cols, response.size.rows);
                  if (response.data) process.write(response.data);
                },
                catch: () => failure("respond", "The Claude sign-in terminal has closed."),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-TRANSCRIPT_LIMIT);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0) {
      return yield* failure("start", "Claude sign-in did not finish. Start again.");
    }
    yield* context.verifying;
  });

  const controller: ProviderAuthController = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    // Instances on the same config directory share one Claude login.
    credentialBinding: { owner: "provider", key: `claude:config:${options.configDir}` },
    methods: Effect.succeed([
      {
        id: CLAUDE_LOGIN_METHOD_ID,
        name: "Claude account",
        description: "Sign in with your Claude subscription or Console account.",
        type: "terminal",
      },
    ]),
    defaultMethodId: CLAUDE_LOGIN_METHOD_ID,
    authenticate: (_methodId, context) =>
      runLogin(context).pipe(Effect.andThen(options.onChanged(true))),
    logout: options.logout.pipe(
      Effect.provide(services),
      Effect.flatMap((result) =>
        result.code === 0
          ? options.onChanged(false)
          : Effect.fail(failure("logout", "Claude could not sign out.")),
      ),
    ),
  });
  return controller;
});
