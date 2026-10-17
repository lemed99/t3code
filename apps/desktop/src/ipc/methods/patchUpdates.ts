import { DesktopPatchUpdateStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PatchUpdates from "../../updates/PatchUpdates.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getPatchUpdateState = makeIpcMethod({
  channel: IpcChannels.PATCH_UPDATE_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopPatchUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.patchUpdates.getState")(function* () {
    return yield* (yield* PatchUpdates.PatchUpdates).state;
  }),
});

export const checkPatchUpdate = makeIpcMethod({
  channel: IpcChannels.PATCH_UPDATE_CHECK_CHANNEL,
  payload: Schema.Void,
  result: DesktopPatchUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.patchUpdates.check")(function* () {
    return yield* (yield* PatchUpdates.PatchUpdates).check;
  }),
});

export const startPatchUpdate = makeIpcMethod({
  channel: IpcChannels.PATCH_UPDATE_START_CHANNEL,
  payload: Schema.Void,
  result: DesktopPatchUpdateStateSchema,
  handler: Effect.fn("desktop.ipc.patchUpdates.start")(function* () {
    return yield* (yield* PatchUpdates.PatchUpdates).start;
  }),
});

export const restartForPatchUpdate = makeIpcMethod({
  channel: IpcChannels.PATCH_UPDATE_RESTART_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.patchUpdates.restart")(function* () {
    yield* (yield* PatchUpdates.PatchUpdates).restartToInstall;
  }),
});
