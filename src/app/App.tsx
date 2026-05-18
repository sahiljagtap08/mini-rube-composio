import React, { useState, useEffect, useRef } from "react";
import { useChat } from "@ai-sdk/react";

type ToolEntry = { slug: string; description: string };
type UploadInfo = { id: string; filename: string; mime: string; size: number };

export default function App() {
  const [attachments, setAttachments] = useState<UploadInfo[]>([]);
  const attachmentsRef = useRef<UploadInfo[]>([]);
  attachmentsRef.current = attachments;

  const { messages, input, handleInputChange, handleSubmit, isLoading, error, data } =
    useChat({
      api: "/api/chat",
      experimental_prepareRequestBody: ({ messages }) => ({
        messages,
        data: { attachments: attachmentsRef.current.map((a) => ({ id: a.id })) },
      }),
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
      },
      onFinish(message, opts) {
        console.log("[chat] finished:", { message, ...opts });
      },
    });

  const lastSeenDataIdx = useRef(0);
  useEffect(() => {
    if (!data) return;
    for (let i = lastSeenDataIdx.current; i < data.length; i++) {
      const part = data[i];
      const kind = (part as any)?.kind;
      if (kind === "error") console.error("[chat:meta]", part);
      else if (kind === "route") console.log("%c[chat:route]", "color:#0a7", part);
      else if (kind === "finish") console.log("%c[chat:finish]", "color:#888", part);
      else console.log("[chat:meta]", part);
    }
    lastSeenDataIdx.current = data.length;
  }, [data]);

  const [activeTool, setActiveTool] = useState("loading...");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [allTools, setAllTools] = useState<ToolEntry[]>([]);
  const [search, setSearch] = useState("");
  const [connections, setConnections] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/connections")
      .then((r) => r.json() as Promise<{ connected: Record<string, boolean> }>)
      .then((d) => setConnections(d.connected ?? {}))
      .catch(() => {});
  }, []);

  async function uploadFile(file: File) {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = (await res.json()) as UploadInfo & { error?: string };
      if (data.error) {
        alert("upload failed: " + data.error);
      } else {
        setAttachments((cur) => [...cur, data]);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeAttachment(id: string) {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }

  function onSubmitWithAttachments(e: React.FormEvent) {
    handleSubmit(e);
    setAttachments([]);
  }

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    fetch("/api/tool")
      .then((r) => r.json() as Promise<{ slug: string }>)
      .then((d) => setActiveTool(d.slug));
  }, []);

  async function openPicker() {
    setPickerOpen(true);
    setSearch("");
    if (allTools.length === 0) {
      const res = await fetch("/api/tools");
      const data = (await res.json()) as { tools?: ToolEntry[] };
      setAllTools(data.tools || []);
    }
  }

  async function selectTool(slug: string) {
    setPickerOpen(false);
    setActiveTool("loading...");
    const res = await fetch("/api/tool/set", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const data = (await res.json()) as { error?: string; slug?: string };
    setActiveTool(data.error ? "error" : data.slug ?? "unknown");
  }

  async function connect(toolkit: string) {
    const res = await fetch(`/api/connect/${toolkit}`, { method: "POST" });
    const data = (await res.json()) as { redirectUrl?: string };
    if (data.redirectUrl) {
      window.open(data.redirectUrl, "_blank", "width=600,height=700");
      const waitRes = await fetch(`/api/connect/${toolkit}/wait`, { method: "POST" });
      const waitData = (await waitRes.json()) as { connected?: boolean };
      if (waitData.connected) {
        setConnections((c) => ({ ...c, [toolkit]: true }));
      }
    }
  }

  const filtered = search
    ? allTools.filter(
        (t) =>
          t.slug.toLowerCase().includes(search.toLowerCase()) ||
          t.description.toLowerCase().includes(search.toLowerCase())
      )
    : allTools;

  return (
    <>
      <header>
        <h1>mini rube</h1>
        <div className="header-right">
          {["googlesuper", "github"].map((tk) => (
            <button
              key={tk}
              className={`connect-btn${connections[tk] ? " connected" : ""}`}
              onClick={() => connect(tk)}
            >
              {connections[tk] ? `${tk} connected` : `Connect ${tk}`}
            </button>
          ))}
        </div>
      </header>

      <div className="tool-bar">
        <label>Active tool:</label>
        <span className="active-tool">{activeTool}</span>
        <button onClick={openPicker}>Change</button>
      </div>

      <div className="chat" ref={chatRef}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {error && <div className="msg error">{error.message}</div>}
      </div>

      {attachments.length > 0 && (
        <div className="attachment-bar">
          {attachments.map((a) => (
            <span key={a.id} className="attachment-chip" title={`${a.mime} · ${a.size}B`}>
              📎 {a.filename}
              <button onClick={() => removeAttachment(a.id)} aria-label="remove">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <form className="input-bar" onSubmit={onSubmitWithAttachments}>
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) uploadFile(f);
          }}
        />
        <button
          type="button"
          className="attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || isLoading}
          title="Attach a file"
        >
          {uploading ? "…" : "📎"}
        </button>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask me anything..."
          autoComplete="off"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>

      {pickerOpen && (
        <div className="tool-picker-overlay" onClick={() => setPickerOpen(false)}>
          <div className="tool-picker" onClick={(e) => e.stopPropagation()}>
            <div className="tool-picker-header">
              <input
                value={search}
                onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
                placeholder="Search tools..."
                autoFocus
              />
              <button className="close-btn" onClick={() => setPickerOpen(false)}>
                &times;
              </button>
            </div>
            <div className="tool-list">
              {allTools.length === 0 ? (
                <div className="tool-list-loading">Loading tools...</div>
              ) : filtered.length === 0 ? (
                <div className="tool-list-loading">No tools found</div>
              ) : (
                filtered.slice(0, 100).map((t) => (
                  <div
                    key={t.slug}
                    className={`tool-item${t.slug === activeTool ? " active" : ""}`}
                    onClick={() => selectTool(t.slug)}
                  >
                    <div className="slug">{t.slug}</div>
                    <div className="desc">{t.description.slice(0, 100)}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
