import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { CheckIcon, Spinner, XIcon } from "./icons";
import { ServiceIcon, describeTool, type Service } from "../utils/toolService";

type JobEvent =
  | { kind: "plan"; chain: string[]; note?: string }
  | { kind: "step"; label: string; detail?: string }
  | { kind: "progress"; processed: number; total: number | null; message?: string }
  | { kind: "done"; result: any }
  | { kind: "error"; error: string };

type Props = { jobId: string; jobType?: string };

// Render a job's tool chain as a row of brand-icon pills with chevrons between
// them. Falls back to the slug → service mapping in toolService so any future
// tool slug renders with the right icon.
function ChainRow({ chain }: { chain: string[] }) {
  if (chain.length === 0) return null;
  return (
    <div className="job-chain">
      {chain.map((slug, i) => {
        const { service, label } = describeTool(slug);
        return (
          <span key={i} className="job-chain-step">
            <span className="job-chain-icon">
              <ServiceIcon service={service as Service} />
            </span>
            <span className="job-chain-label">{label}</span>
            {i < chain.length - 1 && (
              <ChevronRight size={12} className="job-chain-sep" aria-hidden="true" />
            )}
          </span>
        );
      })}
    </div>
  );
}

export function JobCard({ jobId, jobType }: Props) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [lastProgress, setLastProgress] = useState<{ processed: number; total: number | null; message?: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [autoCollapsed, setAutoCollapsed] = useState(false);

  useEffect(() => {
    console.log(`[job-ui] sse connected jobId=${jobId}`);
    const src = new EventSource(`/api/jobs/${jobId}/events`);
    src.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as JobEvent;
        setEvents((cur) => [...cur, e]);
        if (e.kind === "progress") {
          setLastProgress({ processed: e.processed, total: e.total, message: e.message });
        }
        if (e.kind === "done") {
          console.log(`[job-ui] completed jobId=${jobId}`, (e as any).result);
          setStatus("done");
        } else if (e.kind === "error") {
          console.error(`[job-ui] error jobId=${jobId}`, (e as any).error);
          setStatus("error");
        } else {
          console.log(`[job-ui] event ${e.kind}`, (e as any).label ?? (e as any).message ?? "");
        }
      } catch {
        /* ignore malformed */
      }
    };
    src.onerror = () => {
      /* EventSource auto-reconnects; closed once status flips to terminal */
    };
    return () => src.close();
  }, [jobId]);

  // Auto-collapse once the job completes — first transition only, so the
  // user can re-expand and we won't fight them.
  useEffect(() => {
    if ((status === "done" || status === "error") && !autoCollapsed) {
      setAutoCollapsed(true);
      setExpanded(false);
    }
  }, [status, autoCollapsed]);

  const plan = events.find((e) => e.kind === "plan") as Extract<JobEvent, { kind: "plan" }> | undefined;
  const steps = events.filter((e) => e.kind === "step") as Extract<JobEvent, { kind: "step" }>[];
  const done = events.find((e) => e.kind === "done") as Extract<JobEvent, { kind: "done" }> | undefined;
  const error = events.find((e) => e.kind === "error") as Extract<JobEvent, { kind: "error" }> | undefined;

  const title =
    status === "running"
      ? jobType === "github_issues_to_sheet"
        ? "Reading GitHub issues into a Google Sheet…"
        : jobType === "drive_files_to_sheet"
          ? "Reading Drive files into a Google Sheet…"
          : "Working on a long job…"
      : status === "done"
        ? "Long job complete"
        : "Long job failed";

  const result = (done?.result ?? {}) as Record<string, unknown>;
  const sheetUrl = (result as any).sheetUrl as string | undefined;
  const summaryNum =
    (result as any).issuesCount ??
    (result as any).rowsWritten ??
    (result as any).filesCount;
  const summaryLabel =
    (result as any).issuesCount !== undefined
      ? `${(result as any).issuesCount} issues written`
      : (result as any).rowsWritten !== undefined
        ? `${(result as any).rowsWritten} rows written`
        : (result as any).filesCount !== undefined
          ? `${(result as any).filesCount} files processed`
          : null;
  const isTerminal = status !== "running";

  return (
    <div className={`job-card job-card-${status}`}>
      <div className="job-card-head">
        <span className="job-card-status">
          {status === "running" && <Spinner />}
          {status === "done" && <span className="job-state-done"><CheckIcon /></span>}
          {status === "error" && <span className="job-state-error"><XIcon /></span>}
        </span>
        <span className="job-card-title">{title}</span>
        {isTerminal && (
          <button
            type="button"
            className="job-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            <ChevronRight
              size={12}
              className={`job-toggle-chev ${expanded ? "is-open" : ""}`}
              aria-hidden="true"
            />
            <span>{expanded ? "Hide run details" : "Show run details"}</span>
          </button>
        )}
      </div>

      {plan && <ChainRow chain={plan.chain} />}

      {/* Live progress (while running) or compact result row (when done) */}
      {!isTerminal && (
        <>
          {lastProgress && (
            <div className="job-card-progress">
              {lastProgress.total != null ? (
                <div className="job-card-bar">
                  <div
                    className="job-card-bar-fill"
                    style={{
                      width: `${Math.min(100, (lastProgress.processed / Math.max(1, lastProgress.total)) * 100)}%`,
                    }}
                  />
                </div>
              ) : null}
              <span className="job-card-progress-text">
                {lastProgress.processed}
                {lastProgress.total != null ? ` / ${lastProgress.total}` : ""}
                {lastProgress.message ? ` — ${lastProgress.message}` : ""}
              </span>
            </div>
          )}
          <ul className="job-card-steps">
            {steps.slice(-6).map((s, i) => (
              <li key={i} className="job-card-step">
                <span className="step-dot" />
                <span>{s.label}</span>
                {s.detail && <code className="job-card-step-detail">{s.detail}</code>}
              </li>
            ))}
          </ul>
        </>
      )}

      {isTerminal && status === "done" && (
        <div className="job-card-done-row">
          {summaryLabel && <span className="job-card-summary">{summaryLabel}</span>}
          {sheetUrl && (
            <a className="job-card-sheet-link" href={sheetUrl} target="_blank" rel="noopener noreferrer">
              Open Sheet →
            </a>
          )}
        </div>
      )}

      {isTerminal && status === "error" && (
        <div className="job-card-error-row">{error?.error ?? "Unknown error"}</div>
      )}

      {/* Expanded run details (terminal state only) */}
      {isTerminal && expanded && (
        <div className="job-card-expanded">
          <ul className="job-card-steps">
            {steps.map((s, i) => (
              <li key={i} className="job-card-step">
                <span className="step-dot" />
                <span>{s.label}</span>
                {s.detail && <code className="job-card-step-detail">{s.detail}</code>}
              </li>
            ))}
          </ul>
          {sheetUrl && (
            <div className="job-card-meta-row">
              <span className="run-meta-label">Sheet</span>
              <a href={sheetUrl} target="_blank" rel="noopener noreferrer">{sheetUrl}</a>
            </div>
          )}
          {summaryNum !== undefined && (
            <div className="job-card-meta-row">
              <span className="run-meta-label">Count</span>
              <code>{summaryNum}</code>
            </div>
          )}
          <div className="job-card-meta-row">
            <span className="run-meta-label">Job ID</span>
            <code>{jobId}</code>
          </div>
        </div>
      )}
    </div>
  );
}
