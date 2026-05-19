// Small inline banner that polls /api/jobs/:id and surfaces a one-line
// status above the composer. Lets the user know there's still a running
// long-job in the background even after scrolling away.

import { useEffect, useState } from "react";
import { Spinner } from "./icons";

type Snapshot = {
  status: "pending" | "running" | "succeeded" | "failed";
  log: Array<{ ts: number; event: any }>;
  result?: any;
  error?: string;
};

type Props = { jobId: string; jobType?: string };

export function ActiveJobBanner({ jobId, jobType }: Props) {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const r = await fetch(`/api/jobs/${jobId}`);
        if (!r.ok) return;
        const j = (await r.json()) as Snapshot;
        if (!alive) return;
        setSnap(j);
        if (j.status === "running" || j.status === "pending") {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        timer = setTimeout(poll, 4000);
      }
    }
    poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);

  if (!snap) return null;
  if (snap.status === "running" || snap.status === "pending") {
    const lastProgress = [...snap.log]
      .reverse()
      .find(
        (e) =>
          e.event?.kind === "workflow_progress" || e.event?.kind === "progress",
      );
    const e = lastProgress?.event as any;
    const detail = e
      ? e.kind === "workflow_progress"
        ? `${e.current}${e.total ? `/${e.total}` : ""}${e.label ? ` — ${e.label}` : ""}`
        : `${e.processed}${e.total ? `/${e.total}` : ""}${e.message ? ` — ${e.message}` : ""}`
      : "starting…";
    const label =
      jobType === "github_issues_to_sheet"
        ? "GitHub → Sheet export"
        : jobType === "drive_files_to_sheet"
          ? "Drive → Sheet export"
          : "long job";
    return (
      <div className="active-job-banner">
        <Spinner />
        <span>
          <strong>{label}</strong> running · {detail}
        </span>
      </div>
    );
  }
  if (snap.status === "succeeded") {
    const sheetUrl = (snap.result ?? {}).sheetUrl as string | undefined;
    return (
      <div className="active-job-banner active-job-banner-done">
        <span>✓ Job complete</span>
        {sheetUrl && (
          <a href={sheetUrl} target="_blank" rel="noopener noreferrer">
            Open Sheet →
          </a>
        )}
      </div>
    );
  }
  if (snap.status === "failed") {
    return (
      <div className="active-job-banner active-job-banner-error">
        <span>Job failed: {snap.error ?? "unknown"}</span>
      </div>
    );
  }
  return null;
}
