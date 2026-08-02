export type MoveReason = "sort" | "duplicate";

export interface MoveAction {
  kind: "move";
  from: string;
  to: string;
  reason: MoveReason;
  /** Named rule id when reason is sort and a matcher fired. */
  rule?: string;
}

export interface RemoveDirAction {
  kind: "removeDir";
  path: string;
}

export type PlanAction = MoveAction | RemoveDirAction;

export interface Plan {
  actions: PlanAction[];
  sortCount: number;
  duplicateCount: number;
  removeDirCount: number;
}

export function createEmptyPlan(): Plan {
  return {
    actions: [],
    sortCount: 0,
    duplicateCount: 0,
    removeDirCount: 0,
  };
}

export function addMove(
  plan: Plan,
  from: string,
  to: string,
  reason: MoveReason,
  rule?: string,
): void {
  plan.actions.push({ kind: "move", from, to, reason, rule });
  if (reason === "sort") {
    plan.sortCount++;
  } else {
    plan.duplicateCount++;
  }
}

export function addRemoveDir(plan: Plan, dirPath: string): void {
  plan.actions.push({ kind: "removeDir", path: dirPath });
  plan.removeDirCount++;
}

export function printPlan(plan: Plan, dryRun: boolean): void {
  const prefix = dryRun ? "[dry-run] " : "";
  console.log(
    `${prefix}Plan: ${plan.sortCount} sort(s), ${plan.duplicateCount} duplicate(s), ${plan.removeDirCount} empty folder(s)`,
  );

  if (plan.actions.length === 0) {
    console.log(`${prefix}Nothing to do.`);
    return;
  }

  for (const action of plan.actions) {
    if (action.kind === "move") {
      const label =
        action.reason === "sort" && action.rule
          ? `sort[${action.rule}]`
          : action.reason;
      console.log(`${prefix}${label}: ${action.from} -> ${action.to}`);
    } else {
      console.log(`${prefix}removeDir: ${action.path}`);
    }
  }
}
