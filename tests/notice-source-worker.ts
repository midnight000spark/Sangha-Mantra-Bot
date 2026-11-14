import worker from "../src/worker";
import type { Env } from "../src/types";

// Test-only wrapper: drain background tasks deterministically before the host's next input.
// All parsing, ingestion, outbox creation and delivery run in the unmodified real Worker.
export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const tasks: Promise<unknown>[] = [];
    const response = await worker.fetch(request, env, {
      waitUntil(task: Promise<unknown>) { tasks.push(task); },
    } as ExecutionContext);
    await Promise.all(tasks);
    return response;
  },
};
