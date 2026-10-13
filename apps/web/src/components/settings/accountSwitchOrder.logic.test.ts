import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { moveInOrder, switchOrderAccounts } from "./accountSwitchOrder.logic";

const provider = (id: string, driver: string, displayName?: string, enabled = true) => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(driver),
  enabled,
  ...(displayName ? { displayName } : {}),
});

describe("switchOrderAccounts", () => {
  it("lists switchable accounts in the saved order, then the rest", () => {
    const accounts = switchOrderAccounts(
      [
        provider("claudeAgent", "claudeAgent", "Claude Max"),
        provider("claude_team1", "claudeAgent", "Team 1"),
        provider("claude_team2", "claudeAgent"),
        provider("claude_off", "claudeAgent", "Off", false),
        provider("codex", "codex"),
      ],
      ["claude_team2", "claudeAgent"],
    );
    expect(accounts.map((account) => account.label)).toEqual([
      "claude_team2",
      "Claude Max",
      "Team 1",
    ]);
  });

  it("moves an account up or down", () => {
    const accounts = switchOrderAccounts(
      [provider("a", "claudeAgent"), provider("b", "claudeAgent"), provider("c", "claudeAgent")],
      [],
    );
    expect(moveInOrder(accounts, "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveInOrder(accounts, "a", -1)).toEqual(["a", "b", "c"]);
  });
});
