import type { Message as ChatMessage } from "ai";
import { AgentRunSteps, type RouteMeta } from "./AgentRunSteps";
import { RunDetails } from "./RunDetails";

type Props = {
  message: ChatMessage;
  meta?: RouteMeta;
  isStreaming?: boolean;
};

export function Message({ message, meta, isStreaming }: Props) {
  if (message.role === "user") {
    return (
      <div className="msg-row msg-row-user">
        <div className="msg msg-user">{message.content}</div>
      </div>
    );
  }

  if (message.role !== "assistant") return null;

  const toolInvocations = (message as any).toolInvocations ?? [];
  return (
    <div className="msg-row msg-row-assistant">
      <div className="msg-avatar" aria-hidden="true">◐</div>
      <div className="msg msg-assistant">
        <AgentRunSteps
          meta={meta}
          toolInvocations={toolInvocations}
          isStreaming={!!isStreaming}
        />
        {message.content && (
          <div className="msg-content">{message.content}</div>
        )}
        <RunDetails meta={meta} toolInvocations={toolInvocations} />
      </div>
    </div>
  );
}
