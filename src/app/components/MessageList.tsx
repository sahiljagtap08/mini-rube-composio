import { useEffect, useRef } from "react";
import type { Message as ChatMessage } from "ai";
import { Message } from "./Message";
import type { RouteMeta } from "./AgentRunSteps";

type Props = {
  messages: ChatMessage[];
  metaByAssistantIndex: Map<number, RouteMeta>;
  isStreaming: boolean;
};

export function MessageList({ messages, metaByAssistantIndex, isStreaming }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isStreaming]);

  let assistantIdx = -1;
  return (
    <div className="messages">
      {messages.map((m) => {
        let meta: RouteMeta | undefined;
        let streaming = false;
        if (m.role === "assistant") {
          assistantIdx += 1;
          meta = metaByAssistantIndex.get(assistantIdx);
          // Treat the very last message as streaming while the chat is loading
          const isLast = m === messages[messages.length - 1];
          streaming = isStreaming && isLast;
        }
        return (
          <Message key={m.id} message={m} meta={meta} isStreaming={streaming} />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
