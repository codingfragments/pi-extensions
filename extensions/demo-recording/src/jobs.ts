/**
 * Background jobs (IMPLEMENTATION_PLAN §1 principle 5): long engine work runs
 * detached from the tool call; progress goes to the bus/panel/footer and the
 * result is reported back into the pi session when it finishes.
 */

export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface Job<T = unknown> {
  id: string;
  kind: string;
  project: string;
  startedAt: number;
  finishedAt?: number;
  status: JobStatus;
  error?: string;
  result?: T;
  progress?: unknown;
  controller: AbortController;
  done: Promise<void>;
}

export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private seq = 0;

  start<T>(
    kind: string,
    project: string,
    run: (signal: AbortSignal, job: Job<T>) => Promise<T>,
    onFinish?: (job: Job<T>) => void,
  ): Job<T> {
    const running = this.running(kind);
    if (running)
      throw new Error(
        `a ${kind} job is already running (${running.id}) — wait for it or cancel it first`,
      );
    const controller = new AbortController();
    const job = {
      id: `${kind}-${++this.seq}`,
      kind,
      project,
      startedAt: Date.now(),
      status: "running",
      controller,
    } as Job<T>;
    job.done = (async () => {
      try {
        job.result = await run(controller.signal, job);
        job.status = "done";
      } catch (err) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.error = (err as Error).message;
      } finally {
        job.finishedAt = Date.now();
        try {
          onFinish?.(job);
        } catch {
          // reporting must never crash the engine
        }
      }
    })();
    this.jobs.set(job.id, job as Job);
    return job;
  }

  running(kind?: string): Job | undefined {
    return [...this.jobs.values()].find(
      (j) => j.status === "running" && (!kind || j.kind === kind),
    );
  }

  /** Jobs of one project (all when omitted), newest first. */
  list(project?: string): Job[] {
    return [...this.jobs.values()].filter((j) => !project || j.project === project).reverse();
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  latest(kind?: string): Job | undefined {
    return [...this.jobs.values()].filter((j) => !kind || j.kind === kind).at(-1);
  }

  cancel(id?: string): Job | undefined {
    const job = id ? this.jobs.get(id) : this.running();
    if (job?.status === "running") job.controller.abort();
    return job;
  }

  async cancelAll(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.status === "running");
    for (const j of running) j.controller.abort();
    await Promise.all(running.map((j) => j.done));
  }
}
