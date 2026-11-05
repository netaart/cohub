function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type TaskRunView = {
  taskType: string;
  userUuid: string | null;
  payload: unknown;
  result: unknown;
};

function hideRunCommandExecutionFields<T extends TaskRunView>(run: T): T {
  if (run.taskType !== "run_command") return run;

  let payload = run.payload;
  if (isRecord(run.payload) && isRecord(run.payload.data)) {
    const sourcePayload = run.payload as Record<string, unknown>;
    const data = run.payload.data;
    const hiddenData = { ...data };
    for (const key of ["command", "cwd", "actionInput", "actorUserId", "viewerUserId", "executionScopes"]) {
      delete hiddenData[key];
    }
    if (Object.keys(hiddenData).length !== Object.keys(data).length) {
      payload = { ...sourcePayload, data: hiddenData };
    }
  }

  let result = run.result;
  if (isRecord(result)) {
    const hiddenResult = { ...result };
    let resultChanged = false;
    for (const key of ["command", "content"]) {
      if (Object.hasOwn(hiddenResult, key)) {
        delete hiddenResult[key];
        resultChanged = true;
      }
    }
    if (resultChanged) result = hiddenResult;
  }

  return payload === run.payload && result === run.result ? run : { ...run, payload, result };
}

export function sanitizeTaskRunProgressForViewer(
  run: Pick<TaskRunView, "taskType" | "payload">,
  progress: unknown,
  canViewSpaceData: boolean,
): unknown {
  if (canViewSpaceData || run.taskType !== "run_command" || !isRecord(progress)) return progress;
  const next = { ...progress };
  let changed = false;
  for (const key of ["command", "content"]) {
    if (Object.hasOwn(next, key)) {
      delete next[key];
      changed = true;
    }
  }
  return changed ? next : progress;
}

/**
 * Keep stored task snapshots intact. Space viewers receive the full snapshot;
 * the owner fallback receives the task summary without execution fields.
 */
export function sanitizeTaskRunPricingForViewer<T extends TaskRunView>(
  run: T,
  viewerUserId: string | null | undefined,
  options?: { canViewSpaceData?: boolean },
): T {
  let next = run;
  if (run.taskType === "create_space" && isRecord(run.payload) && isRecord(run.payload.data)) {
    const data = { ...run.payload.data };
    if (Object.hasOwn(data, "gitToken")) {
      delete data.gitToken;
      next = { ...next, payload: { ...run.payload, data } };
    }
  }

  if (options?.canViewSpaceData === false) {
    next = hideRunCommandExecutionFields(next);
  }

  const isGeneration = next.taskType === "generation";
  const isBillingRetry = next.taskType === "generation.billing_retry";
  if ((!isGeneration && !isBillingRetry) || (viewerUserId && next.userUuid === viewerUserId)) return next;

  let payload = next.payload;
  if (isRecord(payload) && isRecord(payload.data)) {
    const data = { ...payload.data };
    let changed = false;
    for (const key of isBillingRetry
      ? ["modelDiscount", "officialCostUsd", "amountUsd"]
      : ["modelDiscount", "reserveHold"]) {
      if (Object.hasOwn(data, key)) {
        delete data[key];
        changed = true;
      }
    }
    if (changed) payload = { ...payload, data };
  }

  let result = next.result;
  if (isGeneration && isRecord(result) && Object.hasOwn(result, "billing")) {
    const nextResult = { ...result };
    delete nextResult.billing;
    result = nextResult;
  } else if (isBillingRetry && isRecord(result)) {
    const nextResult = { ...result };
    let changed = false;
    for (const key of ["officialCostUsd", "amountUsd", "discountMultiplier"]) {
      if (Object.hasOwn(nextResult, key)) {
        delete nextResult[key];
        changed = true;
      }
    }
    if (changed) result = nextResult;
  }

  return payload === next.payload && result === next.result ? next : { ...next, payload, result };
}
