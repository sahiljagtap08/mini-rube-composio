import { useEffect, useState } from "react";
import { CheckIcon, Spinner, XIcon } from "./icons";

type JobEvent =
  | { kind: "plan"; chain: string[]; note?: string }
  | { kind: "step"; label: string; detail?: string }
  | { kind: "progress"; processed: number; total: number | null; message?: string }
  | { kind: "done"; result: any }
  | { kind: "error"; error: string };

type Props = { jobId: string };

export function JobCard({ jobId }: Props) {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [lastProgress, setLastProgress] = useState<{ processed: number; total: number | null; message?: string } | null>(null);

  useEffect(() => {
    const src = new EventSource(`/api/jobs/${jobId}/events`);
    src.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as JobEvent;
        setEvents((cur) => [...cur, e]);
        if (e.kind === "progress") setLastProgress({ processed: e.processed, total: e.total, message: e.message });
        if (e.kind === "done") setStatus("done");
        if (e.kind === "error") setStatus("error");
      } catch {
        /* ignore malformed */
      }
    };
    src.onerror = () => {
      // EventSource auto-reconnects; we close once status moves to terminal.
    };
    return () => src.close();
  }, [jobId]);

  const plan = events.find((e) => e.kind === "plan") as Extract<JobEvent, { kind: "plan" }> | undefined;
  const steps = events.filter((e) => e.kind === "step") as Extract<JobEvent, { kind: "step" }>[];
  const done = events.find((e) => e.kind === "done") as Extract<JobEvent, { kind: "done" }> | undefined;
  const error = events.find((e) => e.kind === "error") as Extract<JobEvent, { kind: "error" }> | undefined;

  return (
    <div className={`job-card job-card-${status}`}>
      <div className="job-card-head">
        <span className="job-card-status">
          {status === "running" && <Spinner />}
          {status === "done" && <span className="job-state-done"><CheckIcon /></span>}
          {status === "error" && <span className="job-state-error"><XIcon /></span>}
        </span>
        <span className="job-card-title">
          {status === "running" && "Working on a long job…"}
          {status === "done" && "Long job complete"}
          {status === "error" && "Long job failed"}
        </span>
      </div>

      {plan && (
        <div className="job-card-plan">
          <span className="job-card-plan-label">Plan</span>
          <code>{plan.chain.join(" → ")}</code>
          {plan.note && <span className="job-card-plan-note">{plan.note}</span>}
        </div>
      )}

      <ul className="job-card-steps">
        {steps.map((s, i) => (
          <li key={i} className="job-card-step">
            <span className="step-dot" />
            <span>{s.label}</span>
            {s.detail && <code className="job-card-step-detail">{s.detail}</code>}
          </li>
        ))}
      </ul>

      {lastProgress && status === "running" && (
        <div className="job-card-progress">
          {lastProgress.total != null ? (
            <div className="job-card-bar">
              <div
                className="job-card-bar-fill"
                style={{ width: `${Math.min(100, (lastProgress.processed / Math.max(1, lastProgress.total)) * 100)}%` }}
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

      {done && done.result && (
        <div className="job-card-result">
          {(done.result as any).sheetUrl ? (
            <a href={(done.result as any).sheetUrl} target="_blank" rel="noopener noreferrer">
              Open the Google Sheet →
            </a>
          ) : null}
          <pre className="job-card-result-summary">
            {Object.entries(done.result as Record<string, unknown>)
              .filter(([k]) => k !== "sheetUrl")
              .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("\n")}
          </pre>
        </div>
      )}

      {error && <div className="job-card-error">{error.error}</div>}
    </div>
  );
}
