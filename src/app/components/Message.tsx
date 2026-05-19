import type { Message as ChatMessage } from "ai";
import ReactMarkdown from "react-markdown";
import type { RouteMeta, TriageStats } from "../types";
import { RunPanel } from "./RunPanel";
import { JobCard } from "./JobCard";
import { WorkflowChain, reduceWorkflow } from "./WorkflowChain";

type Props = {
  message: ChatMessage;
  meta?: RouteMeta;
  triage?: TriageStats;
  workflowEvents?: any[];
  isStreaming?: boolean;
};

export function Message({ message, meta, triage, workflowEvents, isStreaming }: Props) {
  if (message.role === "user") {
    return (
      <div className="msg-row msg-row-user">
        <div className="msg msg-user">{message.content}</div>
      </div>
    );
  }

  if (message.role !== "assistant") return null;

  const toolInvocations = (message as any).toolInvocations ?? [];
  const hasContent = !!message.content;
  const hasActivity = toolInvocations.length > 0 || meta?.intent === "email_triage";
  const jobId = (meta as any)?.jobId as string | undefined;
  const jobType = (meta as any)?.jobType as string | undefined;

  // If the assistant turn emitted workflow events on the chat data stream
  // (email_triage, calendar_schedule, send_email etc.), render them with the
  // generic WorkflowChain. Long-job turns use JobCard, which is itself a
  // WorkflowChain consumer over SSE.
  const hasWorkflow = !!workflowEvents && workflowEvents.length > 0;
  const workflowState = hasWorkflow ? reduceWorkflow(workflowEvents!) : null;

  return (
    <div className="msg-row msg-row-assistant">
      <div className="msg-avatar" aria-hidden="true">◐</div>
      <div className="msg msg-assistant">
        {jobId ? (
          <JobCard jobId={jobId} jobType={jobType} />
        ) : hasWorkflow && workflowState ? (
          <WorkflowChain state={workflowState} />
        ) : (
          <RunPanel
            meta={meta}
            toolInvocations={toolInvocations}
            triage={triage}
            isStreaming={!!isStreaming}
          />
        )}
        {hasContent ? (
          <div className="msg-content msg-markdown">
            <ReactMarkdown
              components={{
                a: ({ node, ...rest }) => (
                  <a {...rest} target="_blank" rel="noopener noreferrer" />
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        ) : (
          isStreaming && !hasActivity && !jobId && !hasWorkflow && (
            <div className="msg-thinking" aria-label="Thinking">
              <span /><span /><span />
            </div>
          )
        )}
      </div>
    </div>
  );
}
