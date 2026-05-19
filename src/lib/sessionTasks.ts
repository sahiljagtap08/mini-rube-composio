// Tiny in-memory session task store. The assignment is single-user
// (`USER_ID = "candidate"`) so this is just a global Map keyed by user id.
// Each user can have one active task at a time; new tasks supersede the
// previous one. Cleared when the task reaches a terminal state.
//
// Why this exists: lets follow-up status questions ("is it done?") be
// answered deterministically from real task state instead of being routed
// to the LLM, where the model would happily fabricate "yes, sent!".

import { randomUUID } from "node:crypto";

export type SessionTaskIntent =
  | "send_email"
  | "calendar_schedule"
  | "email_triage"
  | "github_issues_to_sheet"
  | "drive_files_to_sheet"
  | "other";

export type SessionTaskStatus =
  | "collecting_input"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type SessionTask = {
  id: string;
  userId: string;
  intent: SessionTaskIntent;
  status: SessionTaskStatus;
  slots: Record<string, unknown>;
  attachmentIds: string[];
  workflowId?: string;
  jobId?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const store = new Map<string, SessionTask>();

export function getActiveTask(userId: string): SessionTask | undefined {
  return store.get(userId);
}

export function upsertTask(
  userId: string,
  patch: Partial<Omit<SessionTask, "id" | "userId" | "createdAt" | "updatedAt">>,
): SessionTask {
  const existing = store.get(userId);
  if (existing) {
    const updated: SessionTask = {
      ...existing,
      ...patch,
      slots: { ...existing.slots, ...(patch.slots ?? {}) },
      attachmentIds: patch.attachmentIds ?? existing.attachmentIds,
      updatedAt: Date.now(),
    };
    store.set(userId, updated);
    return updated;
  }
  const created: SessionTask = {
    id: randomUUID(),
    userId,
    intent: patch.intent ?? "other",
    status: patch.status ?? "collecting_input",
    slots: patch.slots ?? {},
    attachmentIds: patch.attachmentIds ?? [],
    workflowId: patch.workflowId,
    jobId: patch.jobId,
    result: patch.result,
    error: patch.error,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.set(userId, created);
  return created;
}

export function clearTask(userId: string): void {
  store.delete(userId);
}

// Slot requirements per intent. Only the slots used for *pre-execution*
// validation are listed here; per-intent handlers may track more slots
// internally (e.g. email_triage's count).
export type SlotRequirement = {
  intent: SessionTaskIntent;
  required: string[];
};

export const REQUIRED_SLOTS: Record<SessionTaskIntent, string[]> = {
  send_email: ["recipient", "body"],
  calendar_schedule: ["start_time", "attendee"],
  email_triage: [],
  github_issues_to_sheet: ["owner", "repo"],
  drive_files_to_sheet: ["folder_id"],
  other: [],
};

export function missingSlots(task: SessionTask): string[] {
  const req = REQUIRED_SLOTS[task.intent] ?? [];
  return req.filter(
    (k) =>
      task.slots[k] === undefined ||
      task.slots[k] === null ||
      task.slots[k] === "",
  );
}

// Parse common slot shapes out of a single prompt. Idempotent — handlers
// can call this on every turn to top up missing slots from new user input.
const REPO_RX = /\b([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\s*\/\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\b/;
const FOLDER_RX = /folders\/([A-Za-z0-9_-]{10,})/i;
const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

export function extractGenericSlots(prompt: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const repo = REPO_RX.exec(prompt);
  if (repo) {
    out.owner = repo[1];
    out.repo = repo[2];
  }
  const folder = FOLDER_RX.exec(prompt);
  if (folder) out.folder_id = folder[1];
  const emails = prompt.match(EMAIL_RX);
  if (emails && emails.length > 0) {
    out.recipient = emails[0];
    out.attendee = emails[0];
  }
  return out;
}

// Snapshot for status-follow-up answers. Returns a one-line summary the
// chat handler can return verbatim without LLM involvement.
export function summarizeTaskStatus(task: SessionTask): string {
  if (task.status === "running") {
    return `Still running (${task.intent}). I'll update when it finishes.`;
  }
  if (task.status === "succeeded") {
    const r = (task.result ?? {}) as any;
    if (r.summary) return `Done. ${r.summary}${r.sheetUrl ? `\n\nOpen Sheet: ${r.sheetUrl}` : ""}`;
    return `Done.`;
  }
  if (task.status === "failed") {
    return `It failed: ${task.error ?? "unknown error"}`;
  }
  if (task.status === "cancelled") return `That task was cancelled.`;
  if (task.status === "collecting_input") {
    const missing = missingSlots(task);
    if (missing.length > 0) {
      return `Waiting on: ${missing.join(", ")}.`;
    }
    return `Ready to run.`;
  }
  return `Status: ${task.status}`;
}
