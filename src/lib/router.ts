import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, jsonSchema } from "ai";
import { getCatalog, shortlistTools } from "./catalog";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: OPENROUTER_API_KEY,
});

export type RouteMode =
  | "interactive"
  | "long_job"
  | "auth_needed"
  | "clarify"
  | "error";
export type JobType =
  | "github_issues_to_sheet"
  | "drive_files_to_sheet"
  | null;

export type RouteDecision = {
  mode: RouteMode;
  selectedToolSlugs: string[];
  reason: string;
  jobType: JobType;
  clarifyQuestion?: string;
  authToolkits?: string[];
  requiredToolkits: string[];
  errorMessage?: string;
};

function classifyLLMError(msg: string): "credits" | "rate_limit" | "auth" | "other" {
  const m = msg.toLowerCase();
  if (/insufficient.*credit|quota|payment|billing|out of credits/.test(m))
    return "credits";
  if (/rate.?limit|too many requests|429/.test(m)) return "rate_limit";
  if (/unauthor|invalid.*key|forbidden|401|403/.test(m)) return "auth";
  return "other";
}

type RouterModelOutput = {
  mode: "interactive" | "long_job" | "clarify";
  tool_slugs: string[];
  job_type: "github_issues_to_sheet" | "drive_files_to_sheet" | "none";
  reason: string;
  clarify_question?: string;
  required_toolkits?: string[];
};

const ROUTER_SCHEMA = jsonSchema<RouterModelOutput>({
  type: "object",
  required: ["mode", "tool_slugs", "job_type", "reason"],
  additionalProperties: false,
  properties: {
    mode: { type: "string", enum: ["interactive", "long_job", "clarify"] },
    tool_slugs: { type: "array", items: { type: "string" } },
    job_type: {
      type: "string",
      enum: ["github_issues_to_sheet", "drive_files_to_sheet", "none"],
    },
    reason: { type: "string" },
    clarify_question: { type: "string" },
    required_toolkits: {
      type: "array",
      items: { type: "string", enum: ["googlesuper", "github"] },
    },
  },
});

const SYSTEM = `You are the planner for a general agent that uses Composio tools across googlesuper (Gmail, Calendar, Drive, Sheets, Docs, Contacts) and github.

Given the user's prompt and a SHORTLIST of candidate tools (slug, toolkit, short description), decide:

- mode:
  - "interactive" — one-shot or small tasks done in a single tool-using LLM loop (send 1 email, schedule 1 event, read recent N emails where N is small).
  - "long_job" — bulk extraction / processing that would overflow context if streamed through the LLM (e.g. "all issues in repo X to a sheet", "every resume in this drive folder to a sheet", "process all N items").
  - "clarify" — the request is ambiguous (missing repo, missing folder URL, totally unrelated to available toolkits).
- tool_slugs: MINIMUM set of slugs from the shortlist that will be needed. Slugs MUST appear in the shortlist exactly. Prefer fewer.
- job_type:
  - "github_issues_to_sheet" — user wants many/all GitHub issues written to a Google Sheet.
  - "drive_files_to_sheet" — user wants info extracted from many Drive files into a Google Sheet.
  - "none" — otherwise.
- reason: one short sentence.
- clarify_question: only when mode = "clarify".
- required_toolkits: toolkits whose connection the user MUST have for this task (subset of: googlesuper, github).

Heuristics:
- "all", "every", "each", "list of N (N>~50)", "into a sheet", "into a spreadsheet" → likely long_job.
- "send", "schedule", "reply", "draft", "read my last K" with small K → interactive.
- If the user references a person by partial name (e.g. "with karan"), include a contacts/people search tool alongside the calendar tool so the agent can resolve the email.
- For "important emails out of last N", include a Gmail list/search tool (the agent will rely on metadata + snippets), plus optionally a get-message tool for follow-up reads.
- For sending email with an attachment, include the Gmail send tool; the agent will pass the attachment via that tool's attachment parameter.

Never invent slugs. If shortlist is empty or insufficient, return mode="clarify" with a helpful clarify_question.`;

export async function route(
  prompt: string,
  connectedToolkits: Set<string>,
): Promise<RouteDecision> {
  const shortlist = await shortlistTools(prompt, 50);

  const compact = shortlist
    .map((t) => `- ${t.slug} [${t.toolkit}]: ${(t.description || "").slice(0, 140)}`)
    .join("\n");

  const userMsg = `User prompt:\n"""${prompt}"""\n\nShortlist:\n${compact || "(no clearly-relevant tools matched)"}\n\nReturn JSON only.`;

  let obj: RouterModelOutput;
  try {
    const result = await generateObject({
      model: openrouter("moonshotai/kimi-k2"),
      schema: ROUTER_SCHEMA,
      mode: "json",
      system: SYSTEM,
      prompt: userMsg,
    });
    obj = result.object;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error("[router] generateObject failed:", msg);
    const kind = classifyLLMError(msg);
    // For upstream LLM problems (credits, auth, rate limit) bail with a clear
    // error mode — chat fallback would hit the same wall. For other errors
    // (network, transient) keep a tiny keyword shortlist as a soft fallback,
    // but only if the user prompt produced *some* relevant matches.
    if (kind !== "other") {
      let advice = "";
      if (kind === "credits")
        advice =
          " The OpenRouter key bundled by scaffold.sh has run out. Top up at https://openrouter.ai/settings/credits or set OPENROUTER_API_KEY in .env to your own key.";
      else if (kind === "auth")
        advice = " Check that OPENROUTER_API_KEY in .env is valid.";
      else if (kind === "rate_limit")
        advice = " Wait a few seconds and try again.";
      return {
        mode: "error",
        selectedToolSlugs: [],
        reason: `LLM provider error (${kind})`,
        jobType: null,
        requiredToolkits: [],
        errorMessage: msg + advice,
      };
    }
    const fallback = shortlist.slice(0, 5).map((t) => t.slug);
    if (fallback.length === 0) {
      return {
        mode: "interactive",
        selectedToolSlugs: [],
        reason: `router LLM failed (${msg}); no obvious tool match — answering without tools`,
        jobType: null,
        requiredToolkits: [],
      };
    }
    const required = new Set<string>(
      shortlist.slice(0, 5).map((t) => t.toolkit),
    );
    const missing = [...required].filter((tk) => !connectedToolkits.has(tk));
    return {
      mode: missing.length ? "auth_needed" : "interactive",
      selectedToolSlugs: fallback,
      reason: `router LLM failed (${msg}); using keyword fallback`,
      jobType: null,
      requiredToolkits: [...required],
      authToolkits: missing.length ? missing : undefined,
    };
  }

  // validate slugs against catalog
  const catalog = await getCatalog();
  const valid = new Set(catalog.map((t) => t.slug));
  const selected = obj.tool_slugs.filter((s) => valid.has(s));

  // compute required toolkits from model hint + actual selected tools + job_type
  const required = new Set<string>(obj.required_toolkits ?? []);
  for (const s of selected) {
    const t = catalog.find((x) => x.slug === s);
    if (t) required.add(t.toolkit);
  }
  if (obj.job_type === "github_issues_to_sheet") {
    required.add("github");
    required.add("googlesuper");
  } else if (obj.job_type === "drive_files_to_sheet") {
    required.add("googlesuper");
  }

  const jobType: JobType =
    obj.job_type === "none" ? null : (obj.job_type as JobType);

  if (obj.mode === "clarify") {
    return {
      mode: "clarify",
      selectedToolSlugs: selected,
      reason: obj.reason,
      jobType,
      clarifyQuestion: obj.clarify_question,
      requiredToolkits: [...required],
    };
  }

  const missing = [...required].filter((tk) => !connectedToolkits.has(tk));
  if (missing.length > 0) {
    return {
      mode: "auth_needed",
      selectedToolSlugs: selected,
      reason: `${obj.reason} — needs connection: ${missing.join(", ")}`,
      jobType,
      authToolkits: missing,
      requiredToolkits: [...required],
    };
  }

  return {
    mode: obj.mode,
    selectedToolSlugs: selected,
    reason: obj.reason,
    jobType,
    requiredToolkits: [...required],
  };
}
