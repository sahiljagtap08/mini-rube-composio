import { useEffect, useRef } from "react";
import type { Message as ChatMessage } from "ai";
import { Message } from "./Message";
import type { RouteMeta, TriageStats } from "../types";

type Props = {
  messages: ChatMessage[];
  metaByAssistantIndex: Map<number, RouteMeta>;
  triageByAssistantIndex: Map<number, TriageStats>;
  workflowByAssistantIndex: Map<number, any[]>;
  isStreaming: boolean;
};

export function MessageList({
  messages,
  metaByAssistantIndex,
  triageByAssistantIndex,
  workflowByAssistantIndex,
  isStreaming,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isStreaming]);

  let assistantIdx = -1;
  return (
    <div className="messages">
      {messages.map((m) => {
        let meta: RouteMeta | undefined;
        let triage: TriageStats | undefined;
        let workflowEvents: any[] | undefined;
        let streaming = false;
        if (m.role === "assistant") {
          assistantIdx += 1;
          meta = metaByAssistantIndex.get(assistantIdx);
          triage = triageByAssistantIndex.get(assistantIdx);
          workflowEvents = workflowByAssistantIndex.get(assistantIdx);
          const isLast = m === messages[messages.length - 1];
          streaming = isStreaming && isLast;
        }
        return (
          <Message
            key={m.id}
            message={m}
            meta={meta}
            triage={triage}
            workflowEvents={workflowEvents}
            isStreaming={streaming}
          />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
