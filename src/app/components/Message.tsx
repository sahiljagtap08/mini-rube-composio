import type { Message as ChatMessage } from "ai";
import ReactMarkdown from "react-markdown";
import type { RouteMeta, TriageStats } from "../types";
import { RunPanel } from "./RunPanel";

type Props = {
  message: ChatMessage;
  meta?: RouteMeta;
  triage?: TriageStats;
  isStreaming?: boolean;
};

export function Message({ message, meta, triage, isStreaming }: Props) {
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

  return (
    <div className="msg-row msg-row-assistant">
      <div className="msg-avatar" aria-hidden="true">◐</div>
      <div className="msg msg-assistant">
        <RunPanel
          meta={meta}
          toolInvocations={toolInvocations}
          triage={triage}
          isStreaming={!!isStreaming}
        />
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
          isStreaming && !hasActivity && (
            <div className="msg-thinking" aria-label="Thinking">
              <span /><span /><span />
            </div>
          )
        )}
      </div>
    </div>
  );
}
