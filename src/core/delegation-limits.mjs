// Optional operator budgets, rather than a fixed two-level architecture.
export function canDelegate(task,store){const value=store?.data?.settings?.maxDelegationDepth;return !(Number.isSafeInteger(value)&&value>=0)||(task?.depth||0)<value;}
export function delegationCapacity(store){const value=store?.data?.settings?.maxPendingDelegations;return Number.isSafeInteger(value)&&value>0?value:Infinity;}
