import type { ToolInvocation } from "ai";
import type { RouteMeta } from "./AgentRunSteps";

type Props = {
  meta?: RouteMeta;
  toolInvocations: ToolInvocation[];
};

export function RunDetails({ meta, toolInvocations }: Props) {
  if (!meta && toolInvocations.length === 0) return null;
  return (
    <details className="run-details">
      <summary>Run details</summary>
      <div className="run-details-body">
        {meta && (
          <dl className="run-meta">
            <div>
              <dt>Mode</dt>
              <dd>{meta.mode}</dd>
            </div>
            <div>
              <dt>Intent</dt>
              <dd>{meta.intent}</dd>
            </div>
            <div>
              <dt>Selected tools</dt>
              <dd>
                {meta.tools && meta.tools.length > 0
                  ? meta.tools.map((t) => (
                      <code key={t} className="run-meta-slug">{t}</code>
                    ))
                  : "(none)"}
              </dd>
            </div>
            {meta.blocked && meta.blocked.length > 0 && (
              <div>
                <dt>Blocked</dt>
                <dd>
                  {meta.blocked.map((b) => (
                    <code key={b.slug} className="run-meta-slug run-meta-slug-blocked" title={b.reason}>
                      {b.slug}
                    </code>
                  ))}
                </dd>
              </div>
            )}
            <div>
              <dt>Reason</dt>
              <dd>{meta.reason}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{meta.provider} / {meta.model}</dd>
            </div>
          </dl>
        )}
        {toolInvocations.length > 0 && (
          <div className="run-tools">
            <div className="run-tools-title">Tool calls</div>
            {toolInvocations.map((ti) => {
              const r: any = (ti as any).result;
              const isError = r && typeof r === "object" && "error" in r;
              return (
                <div key={ti.toolCallId} className={`run-tool ${isError ? "is-error" : ""}`}>
                  <div className="run-tool-head">
                    <code>{ti.toolName}</code>
                    <span className="run-tool-state">{ti.state}</span>
                  </div>
                  <pre className="run-tool-args">{JSON.stringify(ti.args, null, 2)}</pre>
                  {ti.state === "result" && (
                    <pre className="run-tool-result">
                      {typeof r === "string" ? r : JSON.stringify(r, null, 2).slice(0, 1200)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}
