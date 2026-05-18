import type { ToolInvocation } from "ai";
import { CheckIcon, MinusIcon, Spinner, XIcon } from "./icons";
import { labelForTool } from "../utils/toolLabels";

export type RouteMeta = {
  kind?: string;
  mode?: string;
  intent?: string;
  tools?: string[];
  blocked?: Array<{ slug: string; reason: string }>;
  reason?: string;
  jobType?: string | null;
  provider?: string;
  model?: string;
  authToolkits?: string[] | null;
};

type StepState = "pending" | "active" | "done" | "error" | "blocked";
type Step = { label: string; state: StepState; detail?: string };

type Props = {
  meta?: RouteMeta;
  toolInvocations: ToolInvocation[];
  isStreaming: boolean;
};

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return (
        <span className="step-icon step-icon-done" aria-hidden="true">
          <CheckIcon />
        </span>
      );
    case "active":
      return (
        <span className="step-icon step-icon-active" aria-hidden="true">
          <Spinner />
        </span>
      );
    case "error":
      return (
        <span className="step-icon step-icon-error" aria-hidden="true">
          <XIcon />
        </span>
      );
    case "blocked":
      return (
        <span className="step-icon step-icon-blocked" aria-hidden="true">
          <MinusIcon />
        </span>
      );
    case "pending":
    default:
      return <span className="step-icon step-icon-pending" aria-hidden="true" />;
  }
}

export function AgentRunSteps({ meta, toolInvocations, isStreaming }: Props) {
  const steps: Step[] = [];

  steps.push({ label: "Understanding request", state: "done" });

  if (meta) {
    if (meta.intent === "conversational") {
      steps.push({ label: "Answering", state: isStreaming ? "active" : "done" });
    } else if (meta.mode === "clarify") {
      steps.push({
        label: "Needs clarification",
        state: "blocked",
        detail: meta.reason,
      });
    } else if (meta.mode === "auth_needed") {
      steps.push({
        label: `Connect ${meta.authToolkits?.join(", ")} to continue`,
        state: "blocked",
      });
    } else if (meta.mode === "long_job") {
      steps.push({
        label: `Detected long-running workflow: ${meta.jobType ?? "unknown"}`,
        state: "active",
      });
    } else {
      const count = meta.tools?.length ?? 0;
      steps.push({
        label:
          count > 0
            ? `Selected ${count} tool${count === 1 ? "" : "s"}`
            : "No tools needed",
        state: "done",
      });
    }
  } else if (isStreaming) {
    steps.push({ label: "Routing…", state: "active" });
  }

  for (const ti of toolInvocations) {
    let state: StepState = "active";
    let detail: string | undefined;
    if (ti.state === "result") {
      const r: any = (ti as any).result;
      if (r && typeof r === "object" && "error" in r) {
        state = "error";
        detail = String(r.error).slice(0, 200);
      } else {
        state = "done";
      }
    }
    steps.push({ label: labelForTool(ti.toolName), state, detail });
  }

  if (meta?.blocked?.length) {
    const names = meta.blocked.map((b) => b.slug).join(", ");
    steps.push({
      label: `${meta.blocked.length} tool${meta.blocked.length === 1 ? "" : "s"} blocked by intent filter`,
      state: "blocked",
      detail: names,
    });
  }

  if (isStreaming && toolInvocations.length > 0) {
    steps.push({ label: "Writing answer", state: "active" });
  }

  return (
    <ul className="run-steps" aria-label="Agent run steps">
      {steps.map((s, i) => (
        <li key={i} className={`run-step run-step-${s.state}`}>
          <StepIcon state={s.state} />
          <span className="run-step-label">{s.label}</span>
          {s.detail && <span className="run-step-detail">{s.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
