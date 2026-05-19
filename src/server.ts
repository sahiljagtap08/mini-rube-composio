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
import { saveUpload, getUpload, ensureS3Key, type Upload } from "./lib/uploads";
import { model, MODEL_ID, PROVIDER } from "./lib/ai";
import {
  isReadOnlyIntent,
  isMutating,
  findPlaceholders,
  INTENT_PROFILES,
  type Intent,
} from "./lib/intent";
import { extractEmailSlots, extractEventSlots, extractGitHubSlots } from "./lib/slots";
import { clampToolArgs, clampToolResult } from "./lib/toolGuards";
import { runEmailTriage } from "./lib/handlers/emailTriage";
import {
  runCalendarSchedule,
  formatEventSuccess,
} from "./lib/handlers/calendarSchedule";
import { runGithubIssuesToSheet } from "./lib/handlers/githubIssuesToSheet";
import { runDriveFilesToSheet } from "./lib/handlers/driveFilesToSheet";
import { createJob, getJob, snapshot, subscribe } from "./lib/jobs";

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
  attachments: Upload[];
  streamData?: StreamData;
};

// For SEND_EMAIL-style slugs, ensure each pending upload has been staged in
// Composio's S3 and rewrite the `attachment` argument with the proper shape.
async function maybeInjectAttachments(
  slug: string,
  args: Record<string, unknown>,
  attachments: Upload[],
  toolkitSlug: string,
): Promise<Record<string, unknown>> {
  if (attachments.length === 0) return args;
  if (!/SEND_EMAIL/.test(slug.toUpperCase())) return args;
  const out = { ...args };
  const staged = await Promise.all(
    attachments.map((u) => ensureS3Key(u, slug, toolkitSlug)),
  );
  // The user uploaded file(s) in this conversation — always inject them as
  // the attachment for send-email-shaped tools. Whatever the model put in
  // the `attachment` field is irrelevant; the model doesn't have valid
  // s3keys anyway.
  console.log(
    `[tool:attach] auto-injecting ${staged.length} attachment(s) for ${slug}: ${staged
      .map((s) => s.name)
      .join(", ")}`,
  );
  out.attachment = staged.length === 1 ? staged[0] : staged;
  return out;
}

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
          let safeArgs = clampToolArgs(meta.slug, args as Record<string, unknown>);
          // Auto-resolve attachments → composio S3 for send-email-shaped tools.
          if (turn.attachments.length > 0) {
            try {
              safeArgs = await maybeInjectAttachments(
                meta.slug,
                safeArgs,
                turn.attachments,
                meta.toolkit,
              );
            } catch (e: any) {
              console.error(
                `[tool:attach] failed to stage attachment for ${meta.slug}:`,
                e?.message ?? e,
              );
              return {
                error: `Couldn't stage the attached file for ${meta.slug}: ${e?.message ?? e}. Try removing and re-uploading the file.`,
              };
            }
          }
          const rawResult: any = await executeTool(meta.slug, USER_ID, safeArgs);
          const result: any = clampToolResult(meta.slug, rawResult);
          if (result && result.successful === false) {
            const msg = result.error ?? "tool reported failure";
            console.error(`[tool:fail] ${meta.slug}: ${msg}`);
            return {
              error: msg,
              hint: "Consider whether arguments match the tool's input schema or whether the relevant toolkit is connected.",
            };
          }
          // Emit a frontend-visible "action success" signal for slugs whose
          // success has a real lifecycle effect (e.g. clear attachments).
          if (/SEND_EMAIL/.test(meta.slug.toUpperCase()) && turn.streamData) {
            turn.streamData.append({
              kind: "action_success",
              action: "send_email",
              slug: meta.slug,
              clearAttachments: true,
            } as any);
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

// Compact view of the recent conversation for the router's context window.
// We include up to the last 3 user/assistant turns and skip the active one
// (the latest user message) since it's passed separately.
function recentTurnsForRouter(messages: CoreMessage[]): string {
  const trimmed: { role: string; text: string }[] = [];
  for (let i = messages.length - 2; i >= 0 && trimmed.length < 6; i--) {
    const m = messages[i]!;
    if (m.role !== "user" && m.role !== "assistant") continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((p: any) => (typeof p === "string" ? p : p?.text ?? ""))
        .filter(Boolean)
        .join(" ");
    }
    if (!text) continue;
    trimmed.unshift({ role: m.role, text: text.slice(0, 240) });
  }
  return trimmed.map((t) => `${t.role}: ${t.text}`).join("\n");
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
    // Disconnect every active connected account for this user+toolkit.
    // Composio supports connectedAccounts.delete(id) — we list, filter, and
    // delete each matching one (a user can occasionally have multiple
    // stale entries for one toolkit).
    "/api/disconnect/:toolkit": {
      async POST(req) {
        const toolkit = req.params.toolkit;
        try {
          const res: any = await composio.connectedAccounts.list({
            userIds: [USER_ID],
          });
          const items: any[] =
            res?.items ?? res?.data ?? (Array.isArray(res) ? res : []);
          const matches = items.filter((a) => {
            const tk = (a?.toolkit?.slug ?? a?.toolkit ?? a?.appName ?? "")
              .toString()
              .toLowerCase();
            return tk === toolkit.toLowerCase();
          });
          let deleted = 0;
          for (const m of matches) {
            try {
              await (composio.connectedAccounts as any).delete(m.id);
              deleted += 1;
            } catch (err: any) {
              console.warn(
                `[disconnect] delete ${m.id} failed: ${err?.message ?? err}`,
              );
            }
          }
          // Clean up any pending OAuth link too
          pendingConnections.delete(toolkit);
          return Response.json({ disconnected: deleted, toolkit });
        } catch (err: any) {
          return Response.json(
            { error: err?.message ?? String(err) },
            { status: 500 },
          );
        }
      },
    },

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

    "/api/jobs/:id": {
      async GET(req) {
        const job = getJob(req.params.id);
        if (!job) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json(snapshot(job));
      },
    },

    "/api/jobs/:id/events": {
      async GET(req) {
        const job = getJob(req.params.id);
        if (!job) return Response.json({ error: "not found" }, { status: 404 });
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // replay any events already logged so a late-arriving subscriber
            // sees the full timeline
            for (const e of job.log) {
              controller.enqueue(
                enc.encode(`data: ${JSON.stringify(e.event)}\n\n`),
              );
            }
            if (job.status === "succeeded" || job.status === "failed") {
              controller.close();
              return;
            }
            const unsub = subscribe(job, (event) => {
              try {
                controller.enqueue(
                  enc.encode(`data: ${JSON.stringify(event)}\n\n`),
                );
                if (event.kind === "done" || event.kind === "error") {
                  unsub();
                  controller.close();
                }
              } catch {
                unsub();
              }
            });
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          },
        });
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
          decision = await route(prompt, connected, {
            recentTurns: recentTurnsForRouter(messages),
            hasAttachments: attachments.length > 0,
          });
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
          const jobType = decision.jobType ?? "unknown";
          if (jobType !== "github_issues_to_sheet" && jobType !== "drive_files_to_sheet") {
            return dataStreamReply(
              `Detected a long-running workflow but no executor is wired for "${jobType}". Open an issue.`,
              { ...routerMeta, kind: "error", stage: "long_job", error: "unknown jobType" },
            );
          }
          const job = createJob(jobType, prompt);
          // fire-and-forget worker — runs in the same Bun process; the
          // client polls /api/jobs/:id to render progress.
          (async () => {
            if (jobType === "github_issues_to_sheet") {
              await runGithubIssuesToSheet(job, USER_ID, prompt);
            } else {
              await runDriveFilesToSheet(job, USER_ID, prompt);
            }
          })();
          const friendly =
            jobType === "github_issues_to_sheet"
              ? `Starting a job to read GitHub issues and write them to a Google Sheet.`
              : `Starting a job to read Drive resumes and write them to a Google Sheet.`;
          console.log(`[job:start] id=${job.id} type=${jobType}`);
          return dataStreamReply(friendly, {
            ...routerMeta,
            kind: "job_started",
            jobId: job.id,
            jobType,
          });
        }

        // --- deterministic email_triage path ---
        // Composio's FETCH_EMAILS returns full message bodies + base64
        // attachments which is way too big for the model context. We bypass
        // the generic tool loop entirely: fetch lean, sanitize + rank in code,
        // feed the model only the compact top-N for natural-language wording.
        if (decision.intent === "email_triage") {
          const triage = await runEmailTriage(prompt, USER_ID);
          const today = new Date().toISOString().slice(0, 10);
          const sd = new StreamData();
          sd.append({ ...routerMeta, intent: "email_triage" } as any);
          sd.append({
            kind: "triage",
            ...triage.stats,
            error: triage.error,
          } as any);

          if (triage.error) {
            return dataStreamReply(
              `I tried to fetch your emails but the Gmail tool failed: ${triage.error}\n\nTry reconnecting Google or check the server logs.`,
              { ...routerMeta, kind: "error", stage: "fetch_emails", error: triage.error },
            );
          }

          const triagePayload = JSON.stringify(triage.topEmails, null, 2);
          const intro =
            triage.stats.fetched === 0
              ? `No emails were returned (fetched=0). Acknowledge to the user and suggest checking the Gmail connection or label filters.`
              : `I already fetched ${triage.stats.fetched} recent email${triage.stats.fetched === 1 ? "" : "s"} and ranked them. The top ${triage.topEmails.length} by importance are below.`;

          const system = `You are mini-rube. Today is ${today}. Your output is rendered as Markdown in the UI.

${intro}

The ranked emails (top ${triage.topEmails.length} of ${triage.stats.fetched}) are below. Some fields may be missing — that's fine, just omit the missing piece entirely; do NOT print placeholder text, brackets, the literal word "missing", or markdown formatting around an empty value.

\`\`\`json
${triagePayload}
\`\`\`

Write the answer EXACTLY in this shape (real Markdown — bold with **, italic with _, numbered list as "1." etc.):

1. **<sender or sender's name>** — <subject>
   Reason: <one short clause naming the label (IMPORTANT/STARRED/UNREAD) and/or urgency keyword and/or sender quality>
   <If labels list is non-empty, render one line: Labels: \`LABEL1\` · \`LABEL2\`>
   <If a date value exists in the JSON for that email, render one line: _<date>_>

Rules:
- ${triage.topEmails.length} items, no more, no less. Number them 1 through ${triage.topEmails.length}.
- One blank line between items.
- NEVER write literal "*date*" or "_date_" or "[date]" or any other placeholder. If date is missing, omit the date line entirely.
- NEVER write literal "*sender*", "[subject]", "(missing)" etc. Omit the entire bullet/line if you have nothing real to say.
- Do NOT call any tool. Do NOT print the JSON. Do NOT add a preamble before the list other than ONE short sentence acknowledging you read ${triage.stats.fetched} emails and surfaced ${triage.topEmails.length}.`;

          const result = streamText({
            model,
            system,
            messages,
            maxSteps: 1,
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
        }

        // --- deterministic calendar_schedule path ---
        // CREATE_EVENT is a mutation. The generic loop has been observed
        // fabricating times ("tomorrow at 3 PM") and claiming success without
        // ever calling the tool. We parse the time/duration/attendee in code,
        // verify the tool actually returned a result, and build the final
        // answer from real data only.
        if (decision.intent === "calendar_schedule") {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const recentTurns = recentTurnsForRouter(messages);
          const outcome = await runCalendarSchedule(
            prompt,
            recentTurns,
            USER_ID,
            tz,
          );
          const calMeta = { ...routerMeta, intent: "calendar_schedule" };

          if (outcome.status === "clarify") {
            console.log(
              `[calendar] clarify (${outcome.reason}): ${outcome.message.slice(0, 120)}`,
            );
            return dataStreamReply(outcome.message, {
              ...calMeta,
              kind: "calendar_clarify",
              reason: outcome.reason,
            });
          }
          if (outcome.status === "error") {
            console.log(`[calendar] error: ${outcome.message.slice(0, 200)}`);
            return dataStreamReply(outcome.message, {
              ...calMeta,
              kind: "calendar_error",
              error: outcome.message,
            });
          }
          // success — answer is built from the verified tool result only
          const reply = formatEventSuccess(outcome, tz);
          const enc = new TextEncoder();
          const parts: string[] = [
            `2:${JSON.stringify([calMeta])}\n`,
            `2:${JSON.stringify([
              {
                kind: "action_success",
                action: "create_event",
                slug: "GOOGLESUPER_CREATE_EVENT",
                start: outcome.start.toISOString(),
                end: outcome.end.toISOString(),
                attendees: outcome.attendees,
                eventLink: outcome.eventLink ?? null,
                meetLink: outcome.meetLink ?? null,
              },
            ])}\n`,
            `0:${JSON.stringify(reply)}\n`,
            `2:${JSON.stringify([{ kind: "finish", finishReason: "stop" }])}\n`,
            `d:${JSON.stringify({ finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
          ];
          const stream = new ReadableStream({
            start(controller) {
              for (const p of parts) controller.enqueue(enc.encode(p));
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

        // interactive
        const tools = await getToolsBySlugs(decision.selectedToolSlugs);
        const sd = new StreamData();
        sd.append(routerMeta as any);
        const turnState: TurnState = {
          blockedCount: new Map(),
          fatalBlock: false,
          attachments,
          streamData: sd,
        };
        const toolMap: Record<string, any> = {};
        for (const t of tools)
          Object.assign(toolMap, makeAITool(t, decision.intent, turnState));
        console.log(
          `[chat] final tools=[${tools.map((t) => t.slug).join(", ") || "(none)"}]`,
        );

        const slugList = tools.map((t) => t.slug).join(", ") || "(none)";
        const today = new Date();
        const todayISO = today.toISOString().slice(0, 10);
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const attachmentBlock = attachments.length
          ? `\n\nUploaded file(s) available on this turn (the platform handles uploading them to the right destination — DO NOT ask the user for s3 keys, paths, MIME types, or any technical detail):
${attachments
  .map((a) => `- filename="${a.filename}", mime=${a.mime}, size=${a.size}`)
  .join("\n")}

When calling a send tool that has an "attachment" parameter, you can either:
  (a) omit attachment entirely — the server will auto-fill it from the uploads above; OR
  (b) pass attachment: { name: "<filename from above>", mimetype: "<mime>", s3key: "auto" }
The server intercepts the call, resolves the staged S3 key, and substitutes a valid attachment object. Either way, just CALL the tool — never tell the user you can't find the file.`
          : "";

        // email_triage and calendar_schedule are early-returned above; this
        // slot is only needed for the send_email branch now.
        const emailSlots =
          decision.intent === "send_email" ? extractEmailSlots(prompt) : null;

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
            case "send_email": {
              const s = emailSlots;
              const note = s?.gmailQuery
                ? `\nNote: prompt mentioned filters (${s.gmailQuery}) — those belong to read flows, ignore here.`
                : "";
              const hasAttach = attachments.length > 0;
              const attachClause = hasAttach
                ? `- The user has ALREADY uploaded ${attachments.length} file${attachments.length === 1 ? "" : "s"} via the UI. Their internal metadata (id, filename, mime, size, local path) is listed in the attachment block above this message. You HAVE the path. Pass it directly to the send tool's attachment parameter (try arg names like \`attachment\`, \`attachments\`, \`file_path\`, \`attached_files\` — inspect the tool's input schema).
- NEVER ask the user for: the file's S3 key, file path, MIME type, size, internal id, or any other implementation detail. Those are app internals — the user does not know them and should not be asked. If you find yourself asking "what is the S3 key" or "what is the file path", STOP and just use the metadata above.
- If exactly 1 file is attached, use it without asking which one.
- If 2+ files are attached and the user did not say which, ASK by filename only ("Which file: 'a.pdf' or 'b.pdf'?").
- If the user said "PDF" but the attached file is e.g. a PNG, attach the actual file anyway and briefly note the mismatch ("I see an attached image, not a PDF — attaching it as-is.")`
                : `- The user has NOT uploaded any file. If they say "with the attached PDF" or similar, ASK them to upload the file via the paperclip button in the composer. Do not pretend an attachment exists.`;
              return `\n\nIntent: send_email. Use the Gmail SEND tool (look for SEND_EMAIL / GMAIL_SEND_EMAIL).

Resolving the recipient from the conversation:
- If the user typed an email address like "x@y.com" — use it as recipient_email.
- If the user typed a partial NAME like "nikhil", "karan", "send this to nikhil" — DO NOT pass the bare name to SEND_EMAIL (it returns "Invalid email format"). Instead:
  1. Call the contacts search tool (SEARCH_PEOPLE / GET_PEOPLE / GET_CONTACTS) with that name as the query.
  2. If you get exactly 1 confident match → confirm to the user briefly ("Found Nikhil Tirunagiri <nikhil@…>. Sending now.") and then call SEND_EMAIL.
  3. If multiple matches → list them ("I found 3 contacts named Nikhil — which one? (1) … (2) … (3) …") and wait.
  4. If 0 matches → ask the user for the email address directly ("I couldn't find a contact named Nikhil. What's their email?").
- "this", "him", "her", "it" in the user's message refers to whatever is already in scope on this turn — an attached file, a previously discussed email, etc. The attachment block above (if present) lists files the user has uploaded.

Resolving subject + body:
- recipient(s): reuse any email/contact already resolved this conversation.
- subject: if missing, default to a polite short subject derived from the body — "Hi" if the body is just "hi", or the first ~6 words of the body otherwise. Do NOT keep asking after the user signals urgency ("just send him hi").
- body: if the user said "just send him X", "say X", "tell her X" — body = X verbatim. Do NOT keep asking.
${attachClause}
- Only ASK for a field if it is GENUINELY missing across the entire conversation. Never ask for the same thing twice. Never ask for technical details (no S3, no path, no MIME).
- Do not pick a DRAFT-only tool when the user asked to SEND. If only a DRAFT tool is available, create the draft and tell the user clearly that it's a draft, not a sent email.${note}`;
            }
            case "github_read": {
              const s = extractGitHubSlots(prompt);
              const repoLine =
                s.owner && s.repo
                  ? `Repo: ${s.owner}/${s.repo}.`
                  : `No owner/repo detected in prompt — ASK the user for "owner/repo".`;
              const countLine = s.count
                ? `User asked for ${s.count} items — pass as per_page (cap at 100; if user asks for more, paginate).`
                : `No count specified — default to 10.`;
              return `\n\nIntent: github_read (READ ONLY, github toolkit). Extracted slots: owner=${s.owner ?? "?"}, repo=${s.repo ?? "?"}, state=${s.state}, count=${s.count ?? "10"}, wantsSheet=${s.wantsSheet}.

ACT — do NOT ask the user to confirm read-only operations.
1. ${repoLine}
2. ${countLine} state="${s.state}".
3. Use GITHUB_LIST_REPOSITORY_ISSUES (preferred for "issues in a repo") with arguments like { owner, repo, state: "${s.state}", per_page: ${s.count ?? 10} }. Or GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS if a free-text search is needed.
4. Present results as a compact list: #number · title · state · author · (one-line snippet of body if available). Do NOT call any CREATE/UPDATE/DELETE/CLOSE/LOCK/ADD_LABEL/SET tool — this turn is read-only.`;
            }
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
- ACT on safe defaults. Do NOT ask the user to confirm read-only operations. "Read my last 5 emails" needs no confirmation. Bad: "Would you like me to fetch them?" Good: "Fetching your last 5 emails now…" (then proceed and show results).
- If a required argument is genuinely missing (recipient for send, repo URL for github bulk, folder URL for drive bulk, time for a calendar event), ask. Otherwise pick a safe default and act.
- Do not invent placeholder values like "1a2b3c4d5e6f7890", "<id>", "your_id". Real IDs must come from a previous tool result; to act on a specific message/event/file you must list/search for it first.
- If a tool returns {error:...}, surface the error and suggest a concrete fix; do NOT keep retrying the same call with the same args.
- If the tool only supports a per-call max (e.g. up to 500 results), do NOT tell the user "I can only fetch N". Just fetch the max it supports and slice to what the user asked for.
- NEVER ask the user for internal implementation details: S3 keys, file paths, local paths, MIME types, file sizes, internal IDs, content type headers. If a tool needs these, the system has already given them to you in the system prompt's attachment/context blocks. Read those blocks.
- Look at the FULL conversation history when answering follow-up messages. A bare email address, a date, or "just say hi" is a continuation of the prior task, not a new task. BUT an explicit verb in the active prompt ("schedule…", "send…", "delete…", "read…") OVERRIDES prior context and starts a new task — don't carry stale recipient/attachment state into an unrelated request.
- ANTI-HALLUCINATION (mutating actions): for any CREATE/UPDATE/DELETE/SEND/ADD/REMOVE/MODIFY/INSERT/PATCH action your final answer MUST be grounded in the actual tool result. If the tool was not called, OR returned successful=false, OR returned an error, OR you did not receive a result — DO NOT claim the action happened. Do NOT invent times, IDs, links, or confirmations. If you're unsure, say "I haven't done it yet — I need <X>."
- For calendar/event creation specifically: never claim "scheduled for tomorrow at 3 PM" (or any time) unless you actually called CREATE_EVENT with those values AND the tool returned success. The user said "in 5 mins" means now + 5 minutes, not "tomorrow at some random time".
- Be concise. A few sentences plus a compact list when relevant.${intentBlock}${attachmentBlock}`;

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
