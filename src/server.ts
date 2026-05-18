import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool, jsonSchema, type CoreMessage } from "ai";
import { AUTH_CONFIGS, composio } from "./lib/composio";
import { connectAccount } from "./lib/auth";
import { executeTool } from "./lib/tools";
import {
  getCatalog,
  getToolBySlug,
  getToolsBySlugs,
  type ToolMeta,
} from "./lib/catalog";
import { route, type RouteDecision } from "./lib/router";
import { saveUpload, getUpload, type Upload } from "./lib/uploads";

const USER_ID = "candidate";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
});

const pendingConnections = new Map<
  string,
  Awaited<ReturnType<typeof connectAccount>>
>();

// preload catalog so the first chat doesn't pay the discovery cost
await getCatalog().catch((err) =>
  console.error("[startup] catalog preload failed:", err?.message ?? err),
);

function makeAITool(meta: ToolMeta) {
  return {
    [meta.slug]: tool({
      description: meta.description || meta.slug,
      parameters: jsonSchema(meta.inputSchema ?? { type: "object", properties: {} }),
      execute: async (args) => {
        console.log(`[tool:exec] ${meta.slug}`, JSON.stringify(args).slice(0, 300));
        try {
          const result: any = await executeTool(
            meta.slug,
            USER_ID,
            args as Record<string, unknown>,
          );
          // Composio returns { successful, error, data, ... } — normalize failures
          if (result && result.successful === false) {
            const msg = result.error ?? "tool reported failure";
            console.error(`[tool:fail] ${meta.slug}: ${msg}`);
            return {
              error: msg,
              hint: "Consider whether arguments match the tool's input schema or whether the relevant toolkit is connected.",
            };
          }
          return result;
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          console.error(`[tool:err] ${meta.slug}:`, msg, err?.cause ?? "");
          return { error: msg };
        }
      },
    }),
  };
}

async function getConnectedToolkits(userId: string): Promise<Set<string>> {
  try {
    const res: any = await composio.connectedAccounts.list({ userIds: [userId] });
    const items: any[] = res?.items ?? res?.data ?? (Array.isArray(res) ? res : []);
    const set = new Set<string>();
    for (const a of items) {
      const tk =
        a?.toolkit?.slug ??
        a?.toolkit?.name ??
        a?.toolkit ??
        a?.appName ??
        a?.app_name;
      if (tk) set.add(String(tk).toLowerCase());
    }
    return set;
  } catch (err: any) {
    console.warn("[connections] list failed:", err?.message ?? err);
    return new Set();
  }
}

function lastUserText(messages: CoreMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const parts = m.content
        .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
        .filter(Boolean);
      return parts.join(" ");
    }
  }
  return "";
}

// stream a fixed assistant message in the AI SDK Data Stream Protocol format.
// useChat will render this as a normal assistant message.
function dataStreamReply(text: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(`0:${JSON.stringify(text)}\n`));
      controller.enqueue(
        enc.encode(
          `d:${JSON.stringify({ finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "x-vercel-ai-data-stream": "v1",
    },
  });
}

function formatDecision(d: RouteDecision): string {
  return [
    `mode=${d.mode}`,
    `tools=[${d.selectedToolSlugs.join(", ") || "(none)"}]`,
    d.jobType ? `job=${d.jobType}` : null,
    d.authToolkits?.length ? `missing=${d.authToolkits.join(",")}` : null,
    `reason="${d.reason}"`,
  ]
    .filter(Boolean)
    .join(" ");
}

Bun.serve({
  port: 3001,
  routes: {
    "/api/connect/:toolkit": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        if (!AUTH_CONFIGS[toolkit]) {
          return Response.json(
            {
              error: `Unknown toolkit: ${toolkit}. Available: ${Object.keys(
                AUTH_CONFIGS,
              ).join(", ")}`,
            },
            { status: 400 },
          );
        }
        try {
          const link = await connectAccount(USER_ID, toolkit);
          pendingConnections.set(toolkit, link);
          return Response.json({ redirectUrl: link.redirectUrl, id: link.id });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      },
    },

    "/api/connect/:toolkit/wait": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        const link = pendingConnections.get(toolkit);
        if (!link) {
          return Response.json(
            { error: "No pending connection for " + toolkit },
            { status: 400 },
          );
        }
        try {
          await link.waitForConnection(60_000);
          pendingConnections.delete(toolkit);
          return Response.json({ connected: true, toolkit });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      },
    },

    "/api/connections": {
      async GET() {
        const set = await getConnectedToolkits(USER_ID);
        const status: Record<string, boolean> = {};
        for (const tk of Object.keys(AUTH_CONFIGS)) status[tk] = set.has(tk);
        return Response.json({ connected: status });
      },
    },

    "/api/upload": {
      async POST(req) {
        try {
          const form = await req.formData();
          const file = form.get("file");
          if (!(file instanceof File)) {
            return Response.json({ error: "expected multipart field 'file'" }, { status: 400 });
          }
          const MAX = 25 * 1024 * 1024;
          if (file.size > MAX) {
            return Response.json({ error: `file too large (max ${MAX} bytes)` }, { status: 413 });
          }
          const u = await saveUpload(file);
          return Response.json({
            id: u.id,
            filename: u.filename,
            mime: u.mime,
            size: u.size,
          });
        } catch (err: any) {
          return Response.json({ error: err?.message ?? String(err) }, { status: 500 });
        }
      },
    },

    // ---- legacy endpoints kept so the existing UI doesn't 404. ----
    // The chat path no longer reads from these; they will go away when the UI
    // is reworked in a later phase.
    "/api/tool": {
      GET() {
        return Response.json({ slug: "(router-driven)" });
      },
    },
    "/api/tool/set": {
      async POST() {
        return Response.json(
          { error: "manual tool selection is deprecated; the router picks tools per-prompt" },
          { status: 410 },
        );
      },
    },
    "/api/tools": {
      async GET() {
        try {
          const cat = await getCatalog();
          return Response.json({
            tools: cat.map((t) => ({
              slug: t.slug,
              toolkit: t.toolkit,
              description: t.description,
            })),
          });
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      },
    },

    "/api/chat": {
      async POST(req) {
        const body = (await req.json()) as {
          messages?: CoreMessage[];
          data?: { attachments?: Array<{ id: string }> };
          attachments?: Array<{ id: string }>;
        };
        const messages: CoreMessage[] = body.messages ?? [];
        const prompt = lastUserText(messages);
        const attachmentRefs = body.data?.attachments ?? body.attachments ?? [];
        const attachments: Upload[] = attachmentRefs
          .map((a) => getUpload(a.id))
          .filter((x): x is Upload => !!x);
        if (attachments.length) {
          console.log(
            `[chat] attachments=${attachments
              .map((a) => `${a.filename}(${a.size}b)`)
              .join(", ")}`,
          );
        }

        console.log(`\n[chat] prompt="${prompt.slice(0, 200)}"`);
        const connected = await getConnectedToolkits(USER_ID);
        console.log(`[chat] connected=${[...connected].join(",") || "(none)"}`);

        let decision: RouteDecision;
        try {
          decision = await route(prompt, connected);
        } catch (err: any) {
          console.error("[chat] router error:", err?.message ?? err);
          return dataStreamReply(
            `Sorry — the router failed: ${err?.message ?? err}`,
          );
        }
        console.log(`[chat] route ${formatDecision(decision)}`);

        if (decision.mode === "clarify") {
          return dataStreamReply(
            decision.clarifyQuestion ??
              "I need a bit more detail to act on that. Could you clarify?",
          );
        }

        if (decision.mode === "auth_needed") {
          const tks = decision.authToolkits ?? [];
          return dataStreamReply(
            `I need you to connect ${tks.join(" and ")} before I can run this. Use the connect button${
              tks.length > 1 ? "s" : ""
            } at the top of the page.`,
          );
        }

        if (decision.mode === "error") {
          return dataStreamReply(
            decision.errorMessage ??
              "Upstream LLM provider returned an error. Check server logs.",
          );
        }

        if (decision.mode === "long_job") {
          // Phase 2 will execute. For now report the plan honestly.
          return dataStreamReply(
            `Detected a long-running workflow (${decision.jobType ?? "unknown"}).\nReason: ${
              decision.reason
            }\nSelected tools: ${
              decision.selectedToolSlugs.join(", ") || "(none yet)"
            }\n\nThe deterministic long-job executor will be wired in the next phase.`,
          );
        }

        // interactive
        const tools = await getToolsBySlugs(decision.selectedToolSlugs);
        const toolMap: Record<string, any> = {};
        for (const t of tools) Object.assign(toolMap, makeAITool(t));

        const slugList = tools.map((t) => t.slug).join(", ") || "(none)";
        const today = new Date();
        const todayISO = today.toISOString().slice(0, 10);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const attachmentBlock = attachments.length
          ? `\n\nThe user has attached file(s) on this turn. Use these when calling email-sending or upload tools — pass the local 'path' as the attachment argument (or whatever attachment field the tool expects; consult its input schema):\n${attachments
              .map(
                (a) =>
                  `- id=${a.id} filename="${a.filename}" mime=${a.mime} size=${a.size} path=${a.path}`,
              )
              .join("\n")}`
          : "";

        const system = `You are mini-rube, a general agent for the user's Google apps and GitHub.
Today is ${todayISO} (timezone ${tz}). "Tomorrow", "next week" etc. are relative to this.

Available tools for this turn: ${slugList}.

Operating rules:
- Use tools when they help; otherwise just answer.
- If a required argument is missing (recipient, repo, folder URL, date/time), ASK the user instead of guessing.
- If a tool returns {error:...}, surface the error to the user and suggest a concrete fix; do NOT keep retrying the same call with the same args.
- Be concise. Summarize results in a few sentences plus a compact list if relevant.

Task-specific guidance:
- "Show important emails out of the last N": first call the Gmail list/search tool with a query like 'newer_than:30d' or maxResults=N to retrieve metadata + snippets only. Rank importance by Gmail labels (IMPORTANT, STARRED), sender reputation (real people > bulk senders), and snippet keywords. Present the top ~10 with sender, subject, one-line reason. Do NOT fetch the full body for every email — only optionally for the top few if the user asks for details.
- Scheduling a calendar event with a partial name (e.g. "with karan"): FIRST search Google Contacts / People for that name using the available contacts tool. If you find exactly one confident match, use their email as the attendee. If you find multiple candidates or none, ask the user to confirm the email. Never invent an email address. Default event length is 30 minutes if not specified.
- Sending an email with an attachment: inspect the email-send tool's input schema for an 'attachment' / 'attachments' parameter. Pass the local file 'path' provided above (most Composio file tools accept a local path; if the schema requires base64 or a Drive file id, adapt accordingly and tell the user what you did).${attachmentBlock}`;

        const result = streamText({
          model: openrouter("moonshotai/kimi-k2"),
          system,
          messages,
          tools: toolMap,
          maxSteps: 12,
        });
        return result.toDataStreamResponse();
      },
    },
  },
  development: { hmr: true, console: true },
});

console.log("Server running at http://localhost:3001");
// keep the helper referenced so tree-shaking / unused-import lint stays quiet
void getToolBySlug;
