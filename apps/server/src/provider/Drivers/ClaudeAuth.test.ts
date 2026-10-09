import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSetupError, type ProviderAuthState } from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CLAUDE_LOGIN_METHOD_ID, makeClaudeAuth } from "./ClaudeAuth.ts";

const instanceId = ProviderInstanceId.make("claude_team1");

const makeHarness = (options: { readonly signedInAfterLogin: boolean }) =>
  Effect.gen(function* () {
    let spawned: PtyAdapter.PtySpawnInput | undefined;
    let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
    let data: ((value: string) => void) | undefined;
    const written: Array<string> = [];
    const changed: Array<boolean> = [];
    let logoutCode = 0;
    const controller = yield* makeClaudeAuth({
      instanceId,
      binaryPath: "claude",
      environment: { PATH: "/tools", CLAUDE_CONFIG_DIR: "/Users/me/.claude-team1" },
      configDir: "/Users/me/.claude-team1",
      cwd: "/workspace",
      logout: Effect.sync(() => ({ code: logoutCode })),
      onChanged: (signedIn) =>
        Effect.sync(() => changed.push(signedIn)).pipe(
          Effect.andThen(
            signedIn && !options.signedInAfterLogin
              ? Effect.fail(
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: "Not signed in",
                  }),
                )
              : Effect.void,
          ),
        ),
    }).pipe(
      Effect.provideService(PtyAdapter.PtyAdapter, {
        spawn: (input) =>
          Effect.sync(() => {
            spawned = input;
            return {
              pid: 1,
              write: (value) => {
                written.push(value);
              },
              resize: () => {},
              kill: () => {},
              onData: (callback) => {
                data = callback;
                return () => {
                  data = undefined;
                };
              },
              onExit: (callback) => {
                exit = callback;
                return () => {
                  exit = undefined;
                };
              },
            };
          }),
      }),
    );
    const state = (predicate: (state: ProviderAuthState) => boolean) =>
      controller
        .subscribe("owner")
        .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));
    yield* state((value) => (value.methods?.length ?? 0) > 0);
    return {
      controller,
      changed,
      written,
      spawned: () => spawned,
      data: (value: string) => data?.(value),
      exit: (exitCode: number) => exit?.({ exitCode, signal: null }),
      phase: (phase: ProviderAuthState["phase"]) => state((value) => value.phase === phase),
      state,
      setLogoutCode: (code: number) => {
        logoutCode = code;
      },
    };
  });

it.effect("signs a Claude account in with its own config directory in a terminal", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ signedInAfterLogin: true });
    const flow = yield* h.controller.start("owner", Effect.void, CLAUDE_LOGIN_METHOD_ID);
    yield* h.phase("waiting");
    assert.deepEqual(h.spawned(), {
      shell: "claude",
      args: ["auth", "login"],
      cwd: "/workspace",
      cols: 80,
      rows: 24,
      env: { PATH: "/tools", CLAUDE_CONFIG_DIR: "/Users/me/.claude-team1" },
    });
    h.data("Select login method: ");
    yield* h.state(
      (value) =>
        value.interaction?.type === "terminal" &&
        value.interaction.output === "Select login method: ",
    );
    yield* h.controller.respond!("owner", {
      instanceId,
      flowId: flow.flowId!,
      interactionId: "terminal",
      response: { type: "terminal", data: "\r" },
    });
    assert.deepEqual(h.written, ["\r"]);
    h.exit(0);
    yield* h.phase("succeeded");
    assert.deepEqual(h.changed, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails when the login exits early or the account still reads as signed out", () =>
  Effect.gen(function* () {
    const early = yield* makeHarness({ signedInAfterLogin: true });
    yield* early.controller.start("owner", Effect.void, CLAUDE_LOGIN_METHOD_ID);
    yield* early.phase("waiting");
    early.exit(1);
    yield* early.phase("failed");
    assert.deepEqual(early.changed, []);

    const unverified = yield* makeHarness({ signedInAfterLogin: false });
    yield* unverified.controller.start("owner", Effect.void, CLAUDE_LOGIN_METHOD_ID);
    yield* unverified.phase("waiting");
    unverified.exit(0);
    yield* unverified.phase("failed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("signs out with claude auth logout and refreshes the account", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ signedInAfterLogin: true });
    yield* h.controller.logout(Effect.void);
    assert.deepEqual(h.changed, [false]);

    h.setLogoutCode(1);
    assert.equal((yield* Effect.exit(h.controller.logout(Effect.void)))._tag, "Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
