import type { ServerProvider } from "@t3tools/contracts";
import { ArrowDown, ArrowUp } from "lucide-react";

import { Button } from "../ui/button";
import { moveInOrder, switchOrderAccounts } from "./accountSwitchOrder.logic";

/** The order a usage-limit switch tries accounts in; the first with usage left wins. */
export function AccountSwitchOrderList(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly order: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (order: ReadonlyArray<string>) => void;
}) {
  const accounts = switchOrderAccounts(props.providers, props.order);
  if (accounts.length === 0) {
    return (
      <p className="px-4 pb-3 text-xs text-muted-foreground">
        Add a second account of the same provider to choose an order.
      </p>
    );
  }
  return (
    <div className="px-4 pb-3">
      <p className="pb-2 text-xs text-muted-foreground">
        Order: when an account runs out, the thread moves to the first account below that still has
        usage left.
      </p>
      <ol className="divide-y rounded-md border">
        {accounts.map((account, index) => (
          <li key={account.instanceId} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="w-5 text-muted-foreground tabular-nums">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate">{account.label}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${account.label} up`}
              disabled={props.disabled || index === 0}
              onClick={() => props.onChange(moveInOrder(accounts, account.instanceId, -1))}
            >
              <ArrowUp />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${account.label} down`}
              disabled={props.disabled || index === accounts.length - 1}
              onClick={() => props.onChange(moveInOrder(accounts, account.instanceId, 1))}
            >
              <ArrowDown />
            </Button>
          </li>
        ))}
      </ol>
    </div>
  );
}
