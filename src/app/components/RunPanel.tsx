import { useEffect, useState } from "react";
import type { ToolInvocation } from "ai";
import type { RouteMeta, TriageStats } from "../types";
import { describeTool, ServiceIcon, formatBytes, type Service } from "../utils/toolService";
import { CheckIcon, Spinner, XIcon } from "./icons";

type StepState = "active" | "done" | "error";
type Step = {
  service: Service;
  label: string;
  state: StepState;
  detail?: string;
  retries?: number;
};

type Props = {
  meta?: RouteMeta;
  toolInvocations: ToolInvocation[];
  triage?: TriageStats;
  isStreaming: boolean;
};

function StateGlyph({ state }: { state: StepState }) {
  if (state === "active") return <span className="step-state step-state-active"><Spinner /></span>;
  if (state === "done")
    return (
      <span className="step-state step-state-done" aria-label="done">
        <CheckIcon />
      </span>
    );
  return (
    <span className="step-state step-state-error" aria-label="failed">
      <XIcon />
    </span>
  );
}

function buildSteps(
  meta: RouteMeta | undefined,
  invocations: ToolInvocation[],
  triage: TriageStats | undefined,
  isStreaming: boolean,
): Step[] {
  const steps: Step[] = [];
  const isEmailTriage = meta?.intent === "email_triage";

  if (isEmailTriage) {
    if (triage?.error) {
      steps.push({
        service: "gmail",
        label: "Fetching emails",
        state: "error",
        detail: triage.error.slice(0, 160),
      });
      return steps;
    }
    if (!triage) {
      steps.push({ service: "gmail", label: "Fetching emails", state: "active" });
    } else {
      const fetched = triage.fetched ?? 0;
      steps.push({
        service: "gmail",
        label: `Fetched ${fetched} email${fetched === 1 ? "" : "s"}`,
        state: "done",
      });
      const top = triage.topCount ?? 0;
      steps.push({
        service: "rank",
        label: `Ranked top ${top} important`,
        state: "done",
      });
    }
  }

  // Consolidate consecutive calls to the same tool into a single step,
  // tracking retries. (Model failing once then retrying shouldn't render two
  // ugly rows.)
  type Grouped = { ti: ToolInvocation; attempts: number };
  const grouped: Grouped[] = [];
  for (const ti of invocations) {
    const last = grouped[grouped.length - 1];
    if (last && last.ti.toolName === ti.toolName) {
      last.attempts += 1;
      last.ti = ti; // keep newest state — that's the final outcome
    } else {
      grouped.push({ ti, attempts: 1 });
    }
  }

  for (const g of grouped) {
    const { ti } = g;
    const { service, label } = describeTool(ti.toolName);
    let state: StepState = "active";
    let detail: string | undefined;
    if (ti.state === "result") {
      const r: any = (ti as any).result;
      // Composio result shape: { successful, error, data }. Treat as failure
      // only when there is an actual error value — `error: null` on success
      // must NOT show up as "null" in the UI.
      const errVal =
        r && typeof r === "object"
          ? (r as any).error ?? (r as any).message
          : undefined;
      const failed = r?.successful === false || (errVal != null && errVal !== "");
      if (failed) {
        state = "error";
        detail = errVal ? String(errVal).slice(0, 160) : "Failed";
      } else {
        state = "done";
      }
    }
    steps.push({ service, label, state, retries: g.attempts - 1, detail });
  }

  if (isStreaming && steps.length > 0 && steps.every((s) => s.state === "done")) {
    steps.push({ service: "generic", label: "Writing answer", state: "active" });
  }
  return steps;
}

export function RunPanel({ meta, toolInvocations, triage, isStreaming }: Props) {
  const isEmailTriage = meta?.intent === "email_triage";
  const hasToolInvocations = toolInvocations.length > 0;
  const hasActivity = hasToolInvocations || isEmailTriage;

  // Hooks must run unconditionally — early-return AFTER hook calls.
  const [expanded, setExpanded] = useState(false);
  const [autoVisible, setAutoVisible] = useState(true);

  // Collapse automatically once streaming completes (only the first time).
  useEffect(() => {
    if (!isStreaming) setAutoVisible(false);
  }, [isStreaming]);

  if (!hasActivity) return null;

  const steps = buildSteps(meta, toolInvocations, triage, isStreaming);
  if (steps.length === 0) return null;

  const showTimeline = isStreaming || autoVisible || expanded;

  return (
    <div className="run-panel">
      {showTimeline && (
        <ul className="run-timeline" aria-label="Agent run steps">
          {steps.map((s, i) => (
            <li key={i} className={`run-step run-step-${s.state}`}>
              <span className="run-step-icon">
                <ServiceIcon service={s.service} />
              </span>
              <span className="run-step-label">{s.label}</span>
              {s.retries && s.retries > 0 ? (
                <span className="run-step-retries">
                  retried {s.retries}×
                </span>
              ) : null}
              <StateGlyph state={s.state} />
              {s.state === "error" && s.detail ? (
                <span className="run-step-detail" title={s.detail}>{s.detail}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {!isStreaming && (
        <button
          type="button"
          className="run-toggle"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "Hide run details" : "Show run details"}
        </button>
      )}

      {expanded && !isStreaming && (
        <div className="run-meta">
          {meta && (
            <>
              <Row label="Mode">{meta.mode}</Row>
              <Row label="Intent">{meta.intent}</Row>
              {meta.tools && meta.tools.length > 0 && (
                <Row label="Selected">
                  {meta.tools.map((s) => (
                    <code key={s} className="run-meta-slug">{s}</code>
                  ))}
                </Row>
              )}
              {meta.blocked && meta.blocked.length > 0 && (
                <Row label="Blocked">
                  {meta.blocked.map((b) => (
                    <code key={b.slug} className="run-meta-slug run-meta-slug-blocked" title={b.reason}>
                      {b.slug}
                    </code>
                  ))}
                </Row>
              )}
              {meta.reason && <Row label="Reason">{meta.reason}</Row>}
              {(meta.provider || meta.model) && (
                <Row label="Model">{meta.provider} / {meta.model}</Row>
              )}
            </>
          )}
          {triage && (
            <>
              {triage.fetched !== undefined && <Row label="Fetched">{triage.fetched} emails</Row>}
              {triage.rawSize !== undefined && <Row label="Raw size">{formatBytes(triage.rawSize)}</Row>}
              {triage.sanitizedSize !== undefined && (
                <Row label="Sanitized size">{formatBytes(triage.sanitizedSize)}</Row>
              )}
              {triage.finalPayloadSize !== undefined && (
                <Row label="Payload to model">{formatBytes(triage.finalPayloadSize)}</Row>
              )}
              {triage.tokenGuardApplied && (
                <Row label="Token guard">Applied — final payload trimmed to fit context</Row>
              )}
              {triage.durationMs !== undefined && <Row label="Duration">{triage.durationMs} ms</Row>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="run-meta-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
