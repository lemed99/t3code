import type { ServerProvider } from "@t3tools/contracts";

export interface SwitchOrderAccount {
  readonly instanceId: string;
  readonly label: string;
  readonly provider: string;
}

/**
 * Accounts a usage-limit switch can move between: enabled instances of a
 * provider that has more than one. Listed in the saved order, then the rest.
 */
export function switchOrderAccounts(
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "displayName" | "enabled">
  >,
  order: ReadonlyArray<string>,
): ReadonlyArray<SwitchOrderAccount> {
  const counts = new Map<string, number>();
  for (const provider of providers) {
    if (provider.enabled) counts.set(provider.driver, (counts.get(provider.driver) ?? 0) + 1);
  }
  const accounts = providers
    .filter((provider) => provider.enabled && (counts.get(provider.driver) ?? 0) > 1)
    .map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.displayName ?? provider.instanceId,
      provider: provider.driver,
    }));
  const rank = (account: SwitchOrderAccount) => {
    const index = order.indexOf(account.instanceId);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  return accounts.toSorted((left, right) => rank(left) - rank(right));
}

/** The order after moving one account up (-1) or down (+1). */
export function moveInOrder(
  accounts: ReadonlyArray<SwitchOrderAccount>,
  instanceId: string,
  step: -1 | 1,
): ReadonlyArray<string> {
  const ids = accounts.map((account) => account.instanceId);
  const from = ids.indexOf(instanceId);
  const to = from + step;
  if (from === -1 || to < 0 || to >= ids.length) return ids;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
}
