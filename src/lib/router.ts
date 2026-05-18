import { generateObject, jsonSchema } from "ai";
import { getCatalog, shortlistTools } from "./catalog";
import { model } from "./ai";
import {
  filterToolsByIntent,
  INTENT_PROFILES,
  type Intent,
} from "./intent";

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

export type BlockedTool = { slug: string; reason: string };

export type RouteDecision = {
  mode: RouteMode;
  intent: Intent;
  selectedToolSlugs: string[];
  blockedToolSlugs: BlockedTool[];
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
  intent: Intent;
  mode: "interactive" | "long_job" | "clarify";
  tool_slugs: string[];
  job_type: "github_issues_to_sheet" | "drive_files_to_sheet" | "none";
  reason: string;
  clarify_question?: string;
  required_toolkits?: string[];
};

const INTENT_ENUM = Object.keys(INTENT_PROFILES) as Intent[];

const ROUTER_SCHEMA = jsonSchema<RouterModelOutput>({
  type: "object",
  required: ["intent", "mode", "tool_slugs", "job_type", "reason"],
  additionalProperties: false,
  properties: {
    intent: { type: "string", enum: INTENT_ENUM },
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

const PROFILE_DESCRIPTIONS = INTENT_ENUM.map(
  (k) => `  - ${k}: ${INTENT_PROFILES[k].description}`,
).join("\n");

const SYSTEM = `You are the planner for a general agent that uses Composio tools across googlesuper (Gmail, Calendar, Drive, Sheets, Docs, Contacts) and github.

For each user prompt, return:

- intent (pick the single best fit):
${PROFILE_DESCRIPTIONS}

- mode:
  - "interactive" — small, one-shot work via the tool-using LLM loop (send 1 email, schedule 1 event, read recent K messages). conversational intents are ALWAYS interactive with empty tool_slugs.
  - "long_job" — bulk extraction that would overflow context (e.g. "all issues in repo X to a sheet", "every resume in this drive folder to a sheet").
  - "clarify" — request is ambiguous or missing required input (no repo, no folder URL, no recipient for "send an email"). Greetings and capability questions are NOT clarify — they are conversational + interactive with no tools.

- tool_slugs: the MINIMUM set of slugs from the shortlist that will be needed. Slugs MUST appear in the shortlist exactly. For conversational intent, return [].

- job_type: "github_issues_to_sheet" | "drive_files_to_sheet" | "none".
- reason: one short sentence.
- clarify_question: only when mode = "clarify".
- required_toolkits: subset of {googlesuper, github}.

CRITICAL — action verbs decide the intent, not keyword overlap:
- "read/show/list/fetch/find/search/view/summarize/triage" + emails → email_triage (READ ONLY). NEVER pick ADD_LABEL, SEND, DELETE, ARCHIVE, TRASH for these prompts.
- "send/compose/email to" → send_email.
- "schedule/create/book/set up" + event/meeting/calendar → calendar_schedule. If the user names a person by partial name, also include a Contacts/People search tool so the agent can resolve their email.
- "delete/remove/cancel/archive" → only when explicitly requested.
- A prompt like "show me the important ones" means RANK by Gmail's IMPORTANT label, not apply the IMPORTANT label.

"yo", "hi", "hello", "thanks", "what can you do?", "help", "who are you?" → intent="conversational", mode="interactive", tool_slugs=[].

Never invent slugs. If a task is in scope but the request is missing critical inputs, return mode="clarify".`;

function looksConversational(p: string): boolean {
  const s = p.trim().toLowerCase();
  if (s.length === 0) return true;
  if (s.length <= 4) return true; // "yo", "hi", "hey", "ok", "thx"
  const greetingsRx = /^(hi|hey|hello|yo+|sup|hola|howdy|gm|gn|thanks|thank you|thx|ok|okay)\b/;
  if (greetingsRx.test(s)) return true;
  const capRx = /^(what can you do|what do you do|who are you|help|capabilities|what's this|whats this|how does this work)\??$/i;
  if (capRx.test(s)) return true;
  return false;
}

export async function route(
  prompt: string,
  connectedToolkits: Set<string>,
): Promise<RouteDecision> {
  // Fast path for unambiguous chit-chat / capability questions. Skips the LLM
  // call entirely so we don't waste tokens or get a wrong intent.
  if (looksConversational(prompt)) {
    return {
      mode: "interactive",
      intent: "conversational",
      selectedToolSlugs: [],
      blockedToolSlugs: [],
      reason: "conversational fast-path (no tools)",
      jobType: null,
      requiredToolkits: [],
    };
  }

  const shortlist = await shortlistTools(prompt, 50);

  const compact = shortlist
    .map((t) => `- ${t.slug} [${t.toolkit}]: ${(t.description || "").slice(0, 140)}`)
    .join("\n");

  const userMsg = `User prompt:\n"""${prompt}"""\n\nShortlist:\n${compact || "(no clearly-relevant tools matched)"}\n\nReturn JSON only.`;

  let obj: RouterModelOutput;
  try {
    const result = await generateObject({
      model,
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
    if (kind !== "other") {
      let advice = "";
      if (kind === "credits")
        advice =
          " Your LLM provider says you're out of credits. Top up or swap the API key in .env (OPENAI_API_KEY preferred; OPENROUTER_API_KEY fallback).";
      else if (kind === "auth")
        advice = " Check that OPENAI_API_KEY / OPENROUTER_API_KEY in .env is valid.";
      else if (kind === "rate_limit")
        advice = " Wait a few seconds and try again.";
      return {
        mode: "error",
        intent: "other",
        selectedToolSlugs: [],
        blockedToolSlugs: [],
        reason: `LLM provider error (${kind})`,
        jobType: null,
        requiredToolkits: [],
        errorMessage: msg + advice,
      };
    }
    // soft fallback: answer without tools rather than guessing wrong ones
    return {
      mode: "interactive",
      intent: "conversational",
      selectedToolSlugs: [],
      blockedToolSlugs: [],
      reason: `router LLM failed (${msg}); answering without tools`,
      jobType: null,
      requiredToolkits: [],
    };
  }

  const catalog = await getCatalog();
  const valid = new Set(catalog.map((t) => t.slug));
  const modelSelected = obj.tool_slugs.filter((s) => valid.has(s));

  // Intent-based filter (the safety layer the user asked for)
  const filtered = filterToolsByIntent(obj.intent, modelSelected);
  const selected = filtered.allowed;
  const blocked = filtered.blocked;

  // compute required toolkits from filtered selection + job_type hint
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

  // conversational always short-circuits to a no-tools interactive turn,
  // even if the model returned something else.
  if (obj.intent === "conversational") {
    return {
      mode: "interactive",
      intent: "conversational",
      selectedToolSlugs: [],
      blockedToolSlugs: blocked,
      reason: obj.reason || "conversational",
      jobType: null,
      requiredToolkits: [],
    };
  }

  if (obj.mode === "clarify") {
    return {
      mode: "clarify",
      intent: obj.intent,
      selectedToolSlugs: selected,
      blockedToolSlugs: blocked,
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
      intent: obj.intent,
      selectedToolSlugs: selected,
      blockedToolSlugs: blocked,
      reason: `${obj.reason} — needs connection: ${missing.join(", ")}`,
      jobType,
      authToolkits: missing,
      requiredToolkits: [...required],
    };
  }

  return {
    mode: obj.mode,
    intent: obj.intent,
    selectedToolSlugs: selected,
    blockedToolSlugs: blocked,
    reason: obj.reason,
    jobType,
    requiredToolkits: [...required],
  };
}
