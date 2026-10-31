export type SeatTask<T> = {
  agentId: string;
  modelName: string;
  run: () => Promise<T>;
};

// Waits for every seat. One rejection used to abort Promise.all while the
// other requests were still running, so the run record hid their outcomes.
export async function settleSeatTasks<T>(
  tasks: SeatTask<T>[],
  stage: string,
  options?: { sequential?: boolean }
): Promise<T[]> {
  const outcomes = options?.sequential
    ? await runSeatTasksInOrder(tasks)
    : await Promise.allSettled(tasks.map(async (task) => task.run()));
  const lines = outcomes.map((outcome, index) => {
    const task = tasks[index];
    const label = `${task.agentId} (${task.modelName})`;
    if (outcome.status === "fulfilled") return `${label}: completed`;
    return `${label}: failed: ${failureDetail(task.agentId, task.modelName, outcome.reason)}`;
  });
  const failureCount = outcomes.filter((outcome) => outcome.status === "rejected").length;

  if (failureCount > 0) {
    throw new Error(`${stage} failed for ${failureCount} of ${tasks.length} seats.\n${lines.join("\n")}`);
  }

  return outcomes.map((outcome) => {
    if (outcome.status === "rejected") {
      throw new Error(`${stage} rejected a seat after reporting no failures`);
    }
    return outcome.value;
  });
}

async function runSeatTasksInOrder<T>(tasks: SeatTask<T>[]): Promise<PromiseSettledResult<T>[]> {
  const outcomes: PromiseSettledResult<T>[] = [];

  for (const task of tasks) {
    try {
      outcomes.push({ status: "fulfilled", value: await task.run() });
    } catch (reason) {
      outcomes.push({ status: "rejected", reason });
    }
  }

  return outcomes;
}

function failureDetail(agentId: string, modelName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const prefixes = [
    `Proposal failed for ${agentId} (${modelName}): `,
    `${agentId} (${modelName}): `
  ];

  for (const prefix of prefixes) {
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }

  return message;
}
