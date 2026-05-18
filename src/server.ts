import { streamText, tool, jsonSchema, StreamData, type CoreMessage } from "ai";
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
import { model, MODEL_ID, PROVIDER } from "./lib/ai";
import {
  isReadOnlyIntent,
  isMutating,
  findPlaceholders,
  INTENT_PROFILES,
  type Intent,
} from "./lib/intent";
import { extractEmailSlots, extractEventSlots } from "./lib/slots";

const USER_ID = "candidate";

const pendingConnections = new Map<
  string,
  Awaited<ReturnType<typeof connectAccount>>
>();

// preload catalog so the first chat doesn't pay the discovery cost
await getCatalog().catch((err) =>
  console.error("[startup] catalog preload failed:", err?.message ?? err),
);

type TurnState = {
  blockedCount: Map<string, number>;
  fatalBlock: boolean;
};

function makeAITool(meta: ToolMeta, intent: Intent, turn: TurnState) {
  return {
    [meta.slug]: tool({
      description: meta.description || meta.slug,
      parameters: jsonSchema(meta.inputSchema ?? { type: "object", properties: {} }),
      execute: async (args) => {
        console.log(`[tool:exec] ${meta.slug}`, JSON.stringify(args).slice(0, 300));

        function recordBlock(reason: string) {
          const n = (turn.blockedCount.get(meta.slug) ?? 0) + 1;
          turn.blockedCount.set(meta.slug, n);
          let body = reason;
          if (n >= 2) {
            turn.fatalBlock = true;
            body += ` This is attempt ${n} — STOP calling this tool. Either pick a different available tool, or tell the user you cannot complete the request with the tools you have.`;
          }
          console.error(`[tool:block] ${body}`);
          return { error: body };
        }

        if (isReadOnlyIntent(intent) && isMutating(meta.slug)) {
          return recordBlock(
            `Refusing to run mutating tool ${meta.slug} during read-only intent (${intent}).`,
          );
        }

        const fakes = findPlaceholders(args);
        if (fakes.length) {
          const detail = fakes.map((f) => `${f.path}="${f.value}"`).join(", ");
          return recordBlock(
            `Refusing to call ${meta.slug} with placeholder values: ${detail}. Obtain real IDs from a list/search tool first, or ask the user.`,
          );
        }

        try {
          const result: any = await executeTool(
            meta.slug,
            USER_ID,
            args as Record<string, unknown>,
          );
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
// useChat will render the text part as a normal assistant message, and the
// optional `meta` payload arrives in useChat().data so the frontend can log
// it to the browser console.
function dataStreamReply(text: string, meta?: unknown): Response {
  const enc = new TextEncoder();
  const lines: string[] = [];
  if (meta !== undefined) lines.push(`2:${JSON.stringify([meta])}\n`);
  lines.push(`0:${JSON.stringify(text)}\n`);
  lines.push(
    `d:${JSON.stringify({ finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
  );
  const stream = new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l));
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
    `intent=${d.intent}`,
    `tools=[${d.selectedToolSlugs.join(", ") || "(none)"}]`,
    d.blockedToolSlugs.length
      ? `blocked=[${d.blockedToolSlugs.map((b) => b.slug).join(",")}]`
      : null,
    d.jobType ? `job=${d.jobType}` : null,
    d.authToolkits?.length ? `missing=${d.authToolkits.join(",")}` : null,
    `reason="${d.reason}"`,
  ]
    .filter(Boolean)
    .join(" ");
}

Bun.serve({
  port: 3001,
  // OAuth flows can take more than the 10s default. Give /wait headroom.
  idleTimeout: 60,
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

    // Poll-friendly wait endpoint. Waits up to 25s for the link to flip to
    // connected. On timeout returns 200 + {connected:false, pending:true} so
    // the frontend can simply retry without worrying about non-JSON bodies.
    "/api/connect/:toolkit/wait": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        const link = pendingConnections.get(toolkit);
        if (!link) {
          // Maybe they're already connected — check live status first.
          const live = await getConnectedToolkits(USER_ID);
          if (live.has(toolkit)) {
            return Response.json({ connected: true, toolkit });
          }
          return Response.json(
            { connected: false, pending: false, error: "no pending connection — start by POSTing /api/connect/:toolkit" },
            { status: 200 },
          );
        }
        try {
          await link.waitForConnection(25_000);
          pendingConnections.delete(toolkit);
          return Response.json({ connected: true, toolkit });
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          const timedOut = /timeout|timed out|deadline|exceed/i.test(msg);
          return Response.json(
            { connected: false, pending: timedOut, error: msg },
            { status: 200 },
          );
        }
      },
    },

    // Route-only endpoint: returns the router decision without executing any
    // tools. Safe for smoke tests / dry runs.
    "/api/route": {
      async POST(req) {
        try {
          const body = (await req.json()) as { prompt?: string };
          const prompt = body.prompt ?? "";
          const connected = await getConnectedToolkits(USER_ID);
          const decision = await route(prompt, connected);
          return Response.json({ ...decision, connected: [...connected] });
        } catch (err: any) {
          return Response.json({ error: err?.message ?? String(err) }, { status: 500 });
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
          const msg = err?.message ?? String(err);
          console.error("[chat] router error:", msg);
          return dataStreamReply(`Sorry — the router failed: ${msg}`, {
            kind: "error",
            stage: "router",
            error: msg,
          });
        }
        console.log(`[chat] route ${formatDecision(decision)}`);

        const routerMeta = {
          kind: "route",
          mode: decision.mode,
          intent: decision.intent,
          tools: decision.selectedToolSlugs,
          blocked: decision.blockedToolSlugs,
          reason: decision.reason,
          jobType: decision.jobType,
          authToolkits: decision.authToolkits ?? null,
          requiredToolkits: decision.requiredToolkits,
          connected: [...connected],
          provider: PROVIDER,
          model: MODEL_ID,
        };

        if (decision.mode === "clarify") {
          return dataStreamReply(
            decision.clarifyQuestion ??
              "I need a bit more detail to act on that. Could you clarify?",
            routerMeta,
          );
        }

        if (decision.mode === "auth_needed") {
          const tks = decision.authToolkits ?? [];
          return dataStreamReply(
            `I need you to connect ${tks.join(" and ")} before I can run this. Use the connect button${
              tks.length > 1 ? "s" : ""
            } at the top of the page.`,
            routerMeta,
          );
        }

        if (decision.mode === "error") {
          return dataStreamReply(
            decision.errorMessage ??
              "Upstream LLM provider returned an error. Check server logs.",
            { ...routerMeta, kind: "error", stage: "router", error: decision.errorMessage },
          );
        }

        if (decision.mode === "long_job") {
          return dataStreamReply(
            `Detected a long-running workflow (${decision.jobType ?? "unknown"}).\nReason: ${
              decision.reason
            }\nSelected tools: ${
              decision.selectedToolSlugs.join(", ") || "(none yet)"
            }\n\nThe deterministic long-job executor will be wired in the next phase.`,
            routerMeta,
          );
        }

        // interactive
        const tools = await getToolsBySlugs(decision.selectedToolSlugs);
        const turnState: TurnState = { blockedCount: new Map(), fatalBlock: false };
        const toolMap: Record<string, any> = {};
        for (const t of tools)
          Object.assign(toolMap, makeAITool(t, decision.intent, turnState));

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

        const intentBlock = (() => {
          switch (decision.intent) {
            case "conversational":
              return `\n\nThis is a greeting or capability question. Do NOT call any tool.
Briefly introduce yourself and what you can do (3-5 short sentences):
- Email triage — read recent Gmail and surface the important messages.
- Send email — compose and send a message, including with file attachments.
- Schedule calendar events — create events, resolving partial names via Google Contacts.
- GitHub → Sheet — dump issues from a repo into a Google Sheet.
- Drive → Sheet — extract structured info (e.g. resumes) from a Drive folder into a Sheet.`;
            case "email_triage":
              return `\n\nIntent: email_triage (READ ONLY). You may ONLY call list/search/get Gmail tools. NEVER call ADD_LABEL, SEND, DELETE, ARCHIVE, TRASH, MODIFY, DRAFT or any mutating tool — even if "important" appears in the prompt; that means RANK by Gmail's IMPORTANT label, not apply it.
Steps:
1. Call the Gmail list/search tool once with maxResults equal to the user's N (or 100 if they said "last 100"). Get metadata + snippets only.
2. Rank in-memory by labelIds (IMPORTANT, STARRED), sender (real person > bulk/no-reply), and snippet keywords.
3. Present the top ~10 with sender, subject, and a one-line reason. Optionally offer to fetch full bodies for specific ones.
Do not fetch full bodies for every email.`;
            case "send_email":
              return `\n\nIntent: send_email. Use the Gmail send tool.
- Confirm you have: recipient(s), subject, body. If any is missing, ASK the user.
- If attachments are listed above, include them via the tool's attachment parameter (use the local 'path').
- Send only after the user-provided info is complete.`;
            case "calendar_schedule":
              return `\n\nIntent: calendar_schedule.
Steps:
1. If the user named a person by partial name, FIRST call the Contacts/People search tool with that name.
2. If you get exactly one confident match, use their email as the attendee. If 0 or many, ASK the user to confirm the email — never invent one.
3. Resolve dates ("tomorrow" → ${todayISO} + 1 day) in timezone ${tz}. Default duration 30 min.
4. Call the calendar create-event tool.`;
            case "github_issues_to_sheet":
            case "drive_files_to_sheet":
              return `\n\nIntent: ${decision.intent}. (Long-job executor still being wired — Phase 3.)`;
            default:
              return "";
          }
        })();

        const system = `You are mini-rube, a general agent for the user's Google apps and GitHub.
Today is ${todayISO} (timezone ${tz}). "Tomorrow", "next week" etc. are relative to this.

Routed intent: ${decision.intent} — ${INTENT_PROFILES[decision.intent].description}
Available tools for this turn: ${slugList}.

Operating rules:
- If a required argument is missing (recipient, repo, folder URL, date/time, ID), ASK the user — do not invent placeholder values like "1a2b3c4d5e6f7890", "<id>", "your_id".
- Real IDs must come from a previous tool result. To act on a message/event/file you must list/search for it first.
- If a tool returns {error:...}, surface the error and suggest a concrete fix; do NOT keep retrying the same call with the same args.
- Be concise. A few sentences plus a compact list when relevant.${intentBlock}${attachmentBlock}`;

        const sd = new StreamData();
        sd.append(routerMeta as any);

        const result = streamText({
          model,
          system,
          messages,
          tools: toolMap,
          maxSteps: 6,
          onFinish({ finishReason, usage }) {
            console.log(
              `[chat] finish reason=${finishReason} usage=${JSON.stringify(usage)}`,
            );
            sd.append({ kind: "finish", finishReason, usage } as any);
            sd.close();
          },
          onError({ error }) {
            const msg = (error as any)?.message ?? String(error);
            console.error("[streamText:error]", msg);
            sd.append({ kind: "error", stage: "streamText", error: msg } as any);
          },
        });

        return result.toDataStreamResponse({ data: sd });
      },
    },
  },
  development: { hmr: true, console: true },
});

console.log("Server running at http://localhost:3001");
// keep the helper referenced so tree-shaking / unused-import lint stays quiet
void getToolBySlug;
