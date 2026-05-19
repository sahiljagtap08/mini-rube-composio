// In-memory job store + SSE-style fan-out for long-running plans.
// Production would persist this in Postgres/Redis with crash recovery; we
// keep it in-memory for the take-home so the demo runs without infra.

import { randomUUID } from "node:crypto";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

export type JobEvent =
  | { kind: "plan"; chain: string[]; note?: string }
  | { kind: "step"; label: string; detail?: string }
  | { kind: "progress"; processed: number; total: number | null; message?: string }
  | { kind: "done"; result: unknown }
  | { kind: "error"; error: string };

export type LoggedEvent = { ts: number; event: JobEvent };

export type Job = {
  id: string;
  type: string;
  prompt: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  log: LoggedEvent[];
  result?: unknown;
  error?: string;
  subscribers: Set<(event: JobEvent) => void>;
};

const store = new Map<string, Job>();

export function createJob(type: string, prompt: string): Job {
  const job: Job = {
    id: randomUUID(),
    type,
    prompt,
    status: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    log: [],
    subscribers: new Set(),
  };
  store.set(job.id, job);
  console.log(`[job] created ${job.id} type=${type}`);
  return job;
}

export function getJob(id: string): Job | undefined {
  return store.get(id);
}

export function listJobs(): Job[] {
  return [...store.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function emit(job: Job, event: JobEvent): void {
  job.updatedAt = Date.now();
  job.log.push({ ts: job.updatedAt, event });
  if (event.kind === "done") {
    job.status = "succeeded";
    job.result = event.result;
    console.log(`[job:${job.id}] done`);
  } else if (event.kind === "error") {
    job.status = "failed";
    job.error = event.error;
    console.error(`[job:${job.id}] failed: ${event.error}`);
  } else {
    if (job.status === "pending") job.status = "running";
    if (event.kind === "step") {
      console.log(`[job:${job.id}] step: ${event.label}${event.detail ? ` (${event.detail})` : ""}`);
    } else if (event.kind === "progress") {
      console.log(
        `[job:${job.id}] progress: ${event.processed}${event.total ? `/${event.total}` : ""}${event.message ? ` — ${event.message}` : ""}`,
      );
    } else if (event.kind === "plan") {
      console.log(`[job:${job.id}] plan: ${event.chain.join(" → ")}`);
    }
  }
  for (const sub of job.subscribers) {
    try {
      sub(event);
    } catch {
      /* listener crashed; drop silently */
    }
  }
}

export function subscribe(job: Job, fn: (event: JobEvent) => void): () => void {
  job.subscribers.add(fn);
  return () => job.subscribers.delete(fn);
}

// Build a snapshot suitable for /api/jobs/:id GET.
export function snapshot(job: Job): {
  id: string;
  type: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  log: LoggedEvent[];
  result?: unknown;
  error?: string;
} {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    log: job.log,
    result: job.result,
    error: job.error,
  };
}
