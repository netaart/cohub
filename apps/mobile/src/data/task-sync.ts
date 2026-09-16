import type { CohubClient, TaskRunRecord } from "@neta-art/cohub";

export function mergeTaskRuns(current: TaskRunRecord[], incoming: TaskRunRecord[]): TaskRunRecord[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) {
    const previous = byId.get(task.id);
    if (!previous || Date.parse(task.updatedAt) >= Date.parse(previous.updatedAt)) byId.set(task.id, task);
  }
  return [...byId.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

/** Recheck loaded active runs even when new tasks push them out of the first page. */
export async function refreshTaskRuns(client: CohubClient, spaceId: string, current: TaskRunRecord[]): Promise<TaskRunRecord[]> {
  const head = await client.tasks.list({ spaceId, limit: 8 });
  const headIds = new Set(head.runs.map((task) => task.id));
  const activeIds = current.filter((task) => !headIds.has(task.id) && (task.status === "running" || task.status === "pending")).map((task) => task.id);
  const runs = [...head.runs];
  for (let offset = 0; offset < activeIds.length; offset += 100) {
    const response = await client.tasks.getMany(activeIds.slice(offset, offset + 100), { spaceId });
    runs.push(...response.runs);
  }
  return runs;
}
