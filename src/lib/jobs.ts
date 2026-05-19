// In-memory job store + SSE-style fan-out for long-running plans.
// Production would persist this in Postgres/Redis with crash recovery; we
// keep it in-memory for the take-home so the demo runs without infra.

import { randomUUID } from "node:crypto";
import type { WorkflowEvent, WorkflowResult } from "./workflow";

export type JobStatus = "pending" | "running" | "succeeded" | "failed";

// JobEvent is now the WorkflowEvent union plus a handful of legacy event
// kinds we keep around so older clients still work. New handlers should
// only emit WorkflowEvents.
export type JobEvent =
  | WorkflowEvent
  // legacy — kept for backward compat with older SSE consumers
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
  // status transitions for both legacy and workflow events
  if (event.kind === "done" || event.kind === "workflow_done") {
    job.status = "succeeded";
    job.result = (event as any).result ?? {};
    console.log(`[job:${job.id}] done`);
  } else if (event.kind === "error" || event.kind === "workflow_error") {
    job.status = "failed";
    job.error = (event as any).error ?? (event as any).message ?? "unknown";
    console.error(`[job:${job.id}] failed: ${job.error}`);
  } else {
    if (job.status === "pending") job.status = "running";
    switch (event.kind) {
      case "workflow_started":
        console.log(
          `[job:${job.id}] workflow_started: ${event.title} (${event.steps.length} steps)`,
        );
        break;
      case "workflow_step":
        console.log(
          `[job:${job.id}] step ${event.stepId} → ${event.status}${event.detail ? ` (${event.detail})` : ""}`,
        );
        break;
      case "workflow_progress":
        console.log(
          `[job:${job.id}] progress ${event.current}${event.total ? `/${event.total}` : ""}${event.label ? ` — ${event.label}` : ""}`,
        );
        break;
      case "step":
        console.log(`[job:${job.id}] step: ${event.label}${event.detail ? ` (${event.detail})` : ""}`);
        break;
      case "progress":
        console.log(
          `[job:${job.id}] progress: ${event.processed}${event.total ? `/${event.total}` : ""}${event.message ? ` — ${event.message}` : ""}`,
        );
        break;
      case "plan":
        console.log(`[job:${job.id}] plan: ${event.chain.join(" → ")}`);
        break;
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

// Convenience: emit a workflow-step transition referencing a step id.
export function workflowStep(
  job: Job,
  stepId: string,
  status: "pending" | "active" | "done" | "error" | "skipped",
  detail?: string,
): void {
  emit(job, { kind: "workflow_step", stepId, status, detail });
}

export function workflowProgress(
  job: Job,
  current: number,
  total?: number,
  label?: string,
): void {
  emit(job, { kind: "workflow_progress", current, total, label });
}

export function workflowDone(job: Job, result?: WorkflowResult): void {
  emit(job, { kind: "workflow_done", result });
}

export function workflowError(job: Job, message: string): void {
  emit(job, { kind: "workflow_error", message });
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
