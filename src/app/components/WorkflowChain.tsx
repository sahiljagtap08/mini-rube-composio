// Generic workflow renderer. Takes a list of WorkflowStep + the latest
// progress snapshot and draws a horizontal chain with branded service
// icons, status glyphs, and an optional progress bar. Source-agnostic:
// any executor that emits WorkflowEvents can use this — long-job workers,
// deterministic chat handlers, model-driven tool loops.

import { ChevronRight } from "lucide-react";
import type { WorkflowResult, WorkflowStep, StepStatus } from "../../lib/workflow";
import { ServiceIcon, type Service } from "../utils/toolService";
import { CheckIcon, Spinner, XIcon } from "./icons";

export type WorkflowProgress = {
  current: number;
  total?: number;
  label?: string;
};

export type WorkflowState = {
  title?: string;
  steps: WorkflowStep[];
  status: "running" | "done" | "error" | "idle";
  progress?: WorkflowProgress;
  result?: WorkflowResult;
  error?: string;
};

function StatusGlyph({ status }: { status: StepStatus }) {
  if (status === "active")
    return (
      <span className="wf-state wf-state-active" aria-label="running">
        <Spinner />
      </span>
    );
  if (status === "done")
    return (
      <span className="wf-state wf-state-done" aria-label="done">
        <CheckIcon />
      </span>
    );
  if (status === "error")
    return (
      <span className="wf-state wf-state-error" aria-label="failed">
        <XIcon />
      </span>
    );
  if (status === "skipped")
    return (
      <span className="wf-state wf-state-skipped" aria-label="skipped">
        −
      </span>
    );
  return <span className="wf-state wf-state-pending" aria-hidden="true" />;
}

type Props = {
  state: WorkflowState;
  compact?: boolean; // show step labels inline (compact) vs stacked detail (default)
};

export function WorkflowChain({ state, compact = false }: Props) {
  if (state.steps.length === 0) return null;
  return (
    <div className={`wf-chain ${compact ? "is-compact" : ""}`}>
      <ol className="wf-steps">
        {state.steps.map((s, i) => {
          const last = i === state.steps.length - 1;
          return (
            <li key={s.id} className={`wf-step wf-step-${s.status}`}>
              <span className="wf-step-icon">
                <ServiceIcon service={s.service as Service} />
              </span>
              <span className="wf-step-body">
                <span className="wf-step-label">{s.label}</span>
                {s.detail && (
                  <span className="wf-step-detail" title={s.detail}>
                    {s.detail}
                  </span>
                )}
              </span>
              <StatusGlyph status={s.status} />
              {!last && (
                <ChevronRight
                  size={12}
                  className="wf-sep"
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
      {state.status === "running" && state.progress && (
        <div className="wf-progress">
          {state.progress.total != null && (
            <div className="wf-bar">
              <div
                className="wf-bar-fill"
                style={{
                  width: `${Math.min(
                    100,
                    (state.progress.current /
                      Math.max(1, state.progress.total)) *
                      100,
                  )}%`,
                }}
              />
            </div>
          )}
          <span className="wf-progress-text">
            {state.progress.current}
            {state.progress.total != null ? ` / ${state.progress.total}` : ""}
            {state.progress.label ? ` — ${state.progress.label}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

// Reduce a stream of WorkflowEvents into a current WorkflowState. Pure
// function — call after every event, store result in component state.
export function reduceWorkflow(
  events: any[],
  base: WorkflowState = { steps: [], status: "idle" },
): WorkflowState {
  let title = base.title;
  let steps = base.steps;
  let status = base.status;
  let progress = base.progress;
  let result = base.result;
  let error = base.error;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    switch (e.kind) {
      case "workflow_started":
        title = e.title;
        steps = e.steps.map((s: WorkflowStep) => ({ ...s }));
        status = "running";
        break;
      case "workflow_step":
        steps = steps.map((s) =>
          s.id === e.stepId
            ? { ...s, status: e.status, detail: e.detail ?? s.detail }
            : s,
        );
        break;
      case "workflow_progress":
        progress = { current: e.current, total: e.total, label: e.label };
        break;
      case "workflow_done":
        status = "done";
        result = e.result;
        // any still-pending steps that weren't explicitly transitioned →
        // mark done so the chain looks coherent
        steps = steps.map((s) =>
          s.status === "pending" || s.status === "active"
            ? { ...s, status: "done" }
            : s,
        );
        break;
      case "workflow_error":
        status = "error";
        error = e.message;
        steps = steps.map((s) =>
          s.status === "active" ? { ...s, status: "error" } : s,
        );
        break;
    }
  }
  return { title, steps, status, progress, result, error };
}
