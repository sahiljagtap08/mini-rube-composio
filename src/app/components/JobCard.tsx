// Thin shell around WorkflowChain for SSE-backed long jobs. The chain itself
// is fully generic — JobCard's only job is to subscribe to the job's event
// stream and reduce events into a WorkflowState.

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  WorkflowChain,
  reduceWorkflow,
  type WorkflowState,
} from "./WorkflowChain";
import type { WorkflowResult } from "../../lib/workflow";

type Props = { jobId: string; jobType?: string };

export function JobCard({ jobId }: Props) {
  const [events, setEvents] = useState<any[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [autoCollapsed, setAutoCollapsed] = useState(false);

  useEffect(() => {
    console.log(`[job-ui] sse connected jobId=${jobId}`);
    const src = new EventSource(`/api/jobs/${jobId}/events`);
    src.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data);
        setEvents((cur) => [...cur, e]);
        console.log(`[job-ui] event ${e.kind}`, e);
      } catch {
        /* skip malformed */
      }
    };
    return () => src.close();
  }, [jobId]);

  const state: WorkflowState = reduceWorkflow(events);
  const isTerminal = state.status === "done" || state.status === "error";

  useEffect(() => {
    if (isTerminal && !autoCollapsed) {
      setAutoCollapsed(true);
      setExpanded(false);
    }
  }, [isTerminal, autoCollapsed]);

  const result = (state.result ?? {}) as WorkflowResult;
  const summary = pickSummary(result);

  return (
    <div className={`job-card job-card-${state.status}`}>
      <div className="job-card-head">
        <span className="job-card-title">
          {state.title ?? "Workflow"}
        </span>
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

      {/* Compact terminal view: chain stays visible, no progress bar */}
      {!isTerminal && <WorkflowChain state={state} />}

      {isTerminal && state.status === "done" && (
        <div className="job-card-done-row">
          {summary && <span className="job-card-summary">{summary}</span>}
          {result.sheetUrl && (
            <a
              className="job-card-sheet-link"
              href={result.sheetUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Sheet →
            </a>
          )}
        </div>
      )}

      {isTerminal && state.status === "error" && (
        <div className="job-card-error-row">{state.error ?? "Unknown error"}</div>
      )}

      {isTerminal && expanded && (
        <div className="job-card-expanded">
          <WorkflowChain state={state} />
          {result.sheetUrl && (
            <div className="job-card-meta-row">
              <span className="run-meta-label">Sheet</span>
              <a href={result.sheetUrl} target="_blank" rel="noopener noreferrer">
                {result.sheetUrl}
              </a>
            </div>
          )}
          {result.rowsWritten !== undefined && (
            <div className="job-card-meta-row">
              <span className="run-meta-label">Rows</span>
              <code>{result.rowsWritten}</code>
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

function pickSummary(r: WorkflowResult): string | null {
  if (r.summary) return String(r.summary);
  const counts: string[] = [];
  if (r.rowsWritten !== undefined) counts.push(`${r.rowsWritten} rows written`);
  if ((r as any).issuesCount !== undefined && r.rowsWritten === undefined)
    counts.push(`${(r as any).issuesCount} issues`);
  if ((r as any).filesCount !== undefined && r.rowsWritten === undefined)
    counts.push(`${(r as any).filesCount} files`);
  return counts.length ? counts.join(" · ") : null;
}
