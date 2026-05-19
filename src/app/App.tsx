import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { Header } from "./components/Header";
import { Composer } from "./components/Composer";
import { MessageList } from "./components/MessageList";
import { EmptyState } from "./components/EmptyState";
import { ErrorStack, type AppError } from "./components/ErrorCard";
import type { Toolkit } from "./components/ConnectionChips";
import type { RouteMeta, TriageStats } from "./types";
import type { Attachment } from "./components/AttachmentChips";

type UploadInfo = Attachment;

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function App() {
  // attachments live in a ref so prepareRequestBody can read the *latest*
  // value at submit time without re-creating useChat.
  const [attachments, setAttachments] = useState<UploadInfo[]>([]);
  const attachmentsRef = useRef<UploadInfo[]>([]);
  attachmentsRef.current = attachments;

  // Bulletproof clear: any source can call this, idempotent, logs once
  function clearAttachments(reason: string) {
    if (attachmentsRef.current.length === 0) return; // already empty
    console.log(
      `%c[attachments] clearing (reason=${reason}) count=${attachmentsRef.current.length} → 0`,
      "color:#a40",
    );
    attachmentsRef.current = [];
    setAttachments([]);
  }

  const [errors, setErrors] = useState<AppError[]>([]);
  const pushError = (e: Omit<AppError, "id">) =>
    setErrors((cur) => [...cur, { id: uid(), ...e }]);
  const dismissError = (id: string) =>
    setErrors((cur) => cur.filter((e) => e.id !== id));

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    error: chatError,
    data,
    append,
  } = useChat({
    api: "/api/chat",
    experimental_prepareRequestBody: ({ messages }) => {
      const list = attachmentsRef.current ?? [];
      console.log(`[attachments] prepare body count=${list.length}`);
      return {
        messages,
        data: { attachments: list.map((a) => ({ id: a.id })) },
      };
    },
    onResponse(res) {
      console.log(
        `%c[chat] response ${res.status} ${res.statusText}`,
        "color:#888",
      );
      if (!res.ok) {
        res
          .clone()
          .text()
          .then((t) => console.error("[chat] error body:", t))
          .catch(() => {});
      }
    },
    onError(err) {
      console.error("[chat] error:", err);
      pushError({
        kind: "provider",
        message: err.message || "The chat request failed. Check the server logs.",
      });
    },
    onFinish(message, opts) {
      console.log("[chat] finished:", { message, opts });
    },
  });

  // Surface server-streamed data parts (route meta / streamText errors) into
  // both the DevTools console and our route-meta map. Each `kind:"route"` data
  // entry corresponds to the *next* assistant message about to stream.
  const lastSeen = useRef(0);
  const [metaByAssistantIndex, setMetaByIdx] = useState<Map<number, RouteMeta>>(
    new Map(),
  );
  const [triageByAssistantIndex, setTriageByIdx] = useState<
    Map<number, TriageStats>
  >(new Map());

  useEffect(() => {
    if (!data) return;
    for (let i = lastSeen.current; i < data.length; i++) {
      const part = data[i] as any;
      const kind = part?.kind;
      if (kind === "error") {
        console.error("[chat:meta]", part);
        pushError({
          kind: part.stage === "streamText" ? "tool" : "provider",
          message:
            (part.error as string) ?? "An upstream error occurred mid-stream.",
        });
      } else if (kind === "route") {
        console.log("%c[chat:route]", "color:#0a7;font-weight:600", part);
      } else if (kind === "triage") {
        console.log("%c[chat:triage]", "color:#0a7;font-weight:600", part);
      } else if (kind === "job_started") {
        console.log("%c[job-ui] started", "color:#0a7;font-weight:600", part);
      } else if (kind === "action_success") {
        console.log("%c[chat:action_success]", "color:#0a7;font-weight:600", part);
        if (part.action === "send_email" || part.clearAttachments) {
          clearAttachments("action_success event");
        }
      } else if (kind === "finish") {
        console.log("%c[chat:finish]", "color:#888", part);
      } else {
        console.log("[chat:meta]", part);
      }
    }
    lastSeen.current = data.length;

    // Build per-assistant-message maps from the data stream. The order in
    // `data` is: route|job_started → [triage] → [action_success] → [finish]
    // per turn. `job_started` and `route` both anchor a new assistant turn —
    // long-job replies use job_started as their primary meta event.
    const routeMap = new Map<number, RouteMeta>();
    const triageMap = new Map<number, TriageStats>();
    let nextIdx = 0;
    let currentIdx = -1;
    for (const part of data as any[]) {
      if (part?.kind === "route" || part?.kind === "job_started") {
        currentIdx = nextIdx;
        // Merge job-specific fields (jobId, jobType) into the RouteMeta so
        // Message can find them.
        routeMap.set(currentIdx, part as RouteMeta);
        nextIdx += 1;
      } else if (part?.kind === "triage" && currentIdx >= 0) {
        triageMap.set(currentIdx, part as TriageStats);
      }
    }
    setMetaByIdx(routeMap);
    setTriageByIdx(triageMap);
  }, [data]);

  // Connection state
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const [pendingConn, setPendingConn] = useState<Record<string, boolean>>({});

  async function refreshConnections() {
    try {
      const r = await fetch("/api/connections");
      const j = (await r.json()) as { connected?: Record<string, boolean> };
      setConnections(j.connected ?? {});
    } catch (e: any) {
      console.warn("[connections] refresh failed:", e?.message ?? e);
    }
  }
  useEffect(() => {
    refreshConnections();
  }, []);

  async function safeJson<T>(res: Response): Promise<T> {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    return res.json() as Promise<T>;
  }

  async function onDisconnect(toolkit: Toolkit) {
    try {
      const r = await fetch(`/api/disconnect/${toolkit}`, { method: "POST" });
      const data = (await r.json().catch(() => ({}))) as { disconnected?: number; error?: string };
      if (data.error) {
        pushError({ kind: "connection", message: `Disconnect failed: ${data.error}` });
      } else {
        console.log(`[connect] disconnected ${toolkit} (removed=${data.disconnected ?? 0})`);
        setConnections((c) => ({ ...c, [toolkit]: false }));
      }
    } catch (e: any) {
      pushError({ kind: "connection", message: `Disconnect error for ${toolkit}: ${e?.message ?? e}` });
    } finally {
      refreshConnections();
    }
  }

  async function onConnect(toolkit: Toolkit) {
    setPendingConn((c) => ({ ...c, [toolkit]: true }));
    try {
      const startRes = await fetch(`/api/connect/${toolkit}`, { method: "POST" });
      const start = await safeJson<{ redirectUrl?: string; error?: string }>(
        startRes,
      );
      if (!start.redirectUrl) {
        pushError({
          kind: "connection",
          message: start.error
            ? `Couldn't start ${toolkit} connection: ${start.error}`
            : `Couldn't start ${toolkit} connection.`,
        });
        return;
      }
      window.open(start.redirectUrl, "_blank", "width=600,height=720");

      const MAX_ATTEMPTS = 8;
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        try {
          const r = await fetch(`/api/connect/${toolkit}/wait`, {
            method: "POST",
          });
          const w = await safeJson<{
            connected?: boolean;
            pending?: boolean;
            error?: string;
          }>(r);
          if (w.connected) {
            setConnections((c) => ({ ...c, [toolkit]: true }));
            return;
          }
          if (!w.pending) {
            pushError({
              kind: "connection",
              message: w.error ?? `${toolkit} connection failed.`,
            });
            return;
          }
        } catch (e: any) {
          console.warn("[connect] wait parse failed:", e?.message ?? e);
        }
      }
      pushError({
        kind: "connection",
        message: `${toolkit === "googlesuper" ? "Google" : "GitHub"} connection is still pending. Finish authorizing in the popup and click Connect again.`,
      });
    } catch (e: any) {
      pushError({
        kind: "connection",
        message: `Connection error for ${toolkit}: ${e?.message ?? e}`,
      });
    } finally {
      setPendingConn((c) => ({ ...c, [toolkit]: false }));
      refreshConnections();
    }
  }

  // Attachments
  const [uploading, setUploading] = useState(false);
  async function onUploadFile(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await safeJson<UploadInfo & { error?: string }>(res);
      if (data.error) {
        pushError({ kind: "upload", message: data.error });
        return;
      }
      setAttachments((cur) => {
        const next = [...cur, data];
        attachmentsRef.current = next;
        console.log(`[attachments] uploaded id=${data.id} count=${next.length}`);
        return next;
      });
    } catch (e: any) {
      pushError({ kind: "upload", message: e?.message ?? String(e) });
    } finally {
      setUploading(false);
    }
  }
  function onRemoveAttachment(id: string) {
    console.log(`[attachments] manual remove id=${id}`);
    setAttachments((cur) => {
      const next = cur.filter((a) => a.id !== id);
      attachmentsRef.current = next;
      return next;
    });
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    handleSubmit(e);
    // Do NOT clear attachments here. Multi-turn email flows ("send an email
    // with this PDF" → "to nikhil@…" → "just say hi") need the same
    // attachment in scope across turns. We auto-clear only on SEND_EMAIL
    // success (see the effect below) or when the user clicks the X.
  }

  // Fallback path: scan the latest assistant message for a SEND_EMAIL tool
  // invocation whose result is genuinely successful. Independent from the
  // action_success SSE event so we still clear if the event is dropped.
  // Critical: Composio responses have `error` as a real key with value
  // `null` on success — we must check `r.error != null`, not "error" in r.
  useEffect(() => {
    if (messages.length === 0 || attachments.length === 0) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "assistant") continue;
      const toolInvocations = (m as any).toolInvocations ?? [];
      const sent = toolInvocations.some((ti: any) => {
        if (!/SEND_EMAIL/i.test(ti.toolName ?? "")) return false;
        if (ti.state !== "result") return false;
        const r = ti.result;
        if (!r || typeof r !== "object") return true; // result present but opaque → assume success
        // Composio shape: { successful, error, data }. error: null on success.
        const errVal = (r as any).error ?? (r as any).message;
        const reportedFailed = (r as any).successful === false;
        return !reportedFailed && (errVal == null || errVal === "");
      });
      if (sent) {
        clearAttachments("toolInvocations.send_email success");
        return;
      }
      break; // only inspect the latest assistant turn
    }
  }, [messages, attachments.length]);

  function onPickSuggestion(prompt: string) {
    append({ role: "user", content: prompt });
  }

  const hasMessages = messages.length > 0;
  useEffect(() => {
    if (chatError) {
      // Already pushed via onError; nothing extra to do here. Keep effect so
      // we can extend with retry UI later.
    }
  }, [chatError]);

  const metaMap = useMemo(() => metaByAssistantIndex, [metaByAssistantIndex]);
  const triageMap = useMemo(() => triageByAssistantIndex, [triageByAssistantIndex]);

  return (
    <div className="app">
      <Header
        connections={connections}
        pending={pendingConn}
        onConnect={onConnect}
        onDisconnect={onDisconnect}
      />
      <main className="app-main">
        <ErrorStack errors={errors} onDismiss={dismissError} />
        <div className="content">
          {hasMessages ? (
            <MessageList
              messages={messages}
              metaByAssistantIndex={metaMap}
              triageByAssistantIndex={triageMap}
              isStreaming={isLoading}
            />
          ) : (
            <EmptyState onPick={onPickSuggestion} />
          )}
        </div>
        <Composer
          value={input}
          onChange={handleInputChange}
          onSubmit={onSubmit}
          attachments={attachments}
          uploading={uploading}
          onUploadFile={onUploadFile}
          onRemoveAttachment={onRemoveAttachment}
          isLoading={isLoading}
          draftHint={
            attachments.length > 0 && messages.length > 0
              ? `Drafting email with ${attachments.length} attachment${attachments.length === 1 ? "" : "s"} — will be reused on follow-up messages`
              : undefined
          }
        />
      </main>
    </div>
  );
}
