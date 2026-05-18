import { generateObject, jsonSchema } from "ai";
import {
  getCatalog,
  shortlistTools,
  getBestEmailReadTools,
  getBestGitHubIssueReadTools,
  getBestContactsSearchTools,
  getBestSendEmailTools,
} from "./catalog";
import { model } from "./ai";
import {
  filterToolsByIntent,
  INTENT_PROFILES,
  type Intent,
} from "./intent";
import { extractEventSlots } from "./slots";

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
  - "interactive" — DEFAULT. Small, one-shot work via the tool-using LLM loop (send 1 email, schedule 1 event, read recent K messages, summarize a handful of issues/files). conversational intents are ALWAYS interactive with empty tool_slugs.
  - "long_job" — ONLY when BOTH conditions hold:
      (a) the prompt explicitly mentions writing output to a Google Sheet / Spreadsheet (literal word "sheet" or "spreadsheet"), AND
      (b) the prompt asks for "all"/"every" items or describes bulk extraction.
      Examples of long_job: "all issues in repo X into a google sheet", "every resume in this drive folder into a spreadsheet".
      Examples that are NOT long_job (use interactive): "summarize the last 5 issues", "list 20 emails", "show me all my labels". Even "read all my emails" without a sheet output is interactive.
  - "clarify" — request is ambiguous or missing required input (no repo, no folder URL, no recipient for "send an email"). Greetings and capability questions are NOT clarify — they are conversational + interactive with no tools.

- tool_slugs: the MINIMUM set of slugs from the shortlist that will be needed. Slugs MUST appear in the shortlist exactly. For conversational intent, return [].

- job_type: "github_issues_to_sheet" | "drive_files_to_sheet" | "none".
- reason: one short sentence.
- clarify_question: only when mode = "clarify".
- required_toolkits: subset of {googlesuper, github}.

CRITICAL — action verbs and toolkit nouns decide the intent, not keyword overlap:
- "read/show/list/fetch/find/search/view/summarize/triage" + EMAIL/INBOX/GMAIL/MESSAGE → email_triage (READ ONLY, googlesuper). NEVER pick ADD_LABEL, SEND, DELETE, ARCHIVE, TRASH for these prompts.
- "send/compose/email to" → send_email (googlesuper).
- "schedule/create/book/set up" + event/meeting/calendar → calendar_schedule (googlesuper). If the user names a person by partial name, also include a Contacts/People search tool so the agent can resolve their email.
- "read/list/show/summarize/find" + repo/owner/repository/issue/PR/pull request/GitHub → github_read (READ ONLY, github toolkit). Examples: "summarize the last 5 open issues from owner/repo", "show closed issues in owner/repo", "list PRs in owner/repo". Pick GITHUB_LIST_REPOSITORY_ISSUES or GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS — never CREATE/UPDATE/DELETE/CLOSE/LOCK/ADD_LABEL/SET tools.
- A prompt that mentions GitHub but ALSO asks to write the output into a Google Sheet/Spreadsheet → github_issues_to_sheet (long_job), not github_read.
- "delete/remove/cancel/archive" → only when explicitly requested.
- A prompt like "show me the important ones" means RANK by Gmail's IMPORTANT label, not apply the IMPORTANT label.

"yo", "hi", "hello", "thanks", "what can you do?", "help", "who are you?" → intent="conversational", mode="interactive", tool_slugs=[].

FOLLOW-UPS — keep the prior task's intent: if the ACTIVE prompt is a short fragment (a bare email address, "just send him hi", "subject is foo", "yes go ahead", "make it 30 min") AND the recent conversation shows an in-progress task, classify as the SAME intent as that task. Don't reset to conversational/clarify for one-line follow-ups inside an ongoing flow.

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

export type RouteContext = {
  // Most recent user/assistant pairs (truncated). Lets the router classify
  // short follow-ups ("nikhil@example.com", "just send him hi") as
  // continuations of the prior task instead of fresh intents.
  recentTurns?: string;
  // Whether the user has uploaded files that are still in scope for the
  // current task. Used by the router to prefer send_email when ambiguous.
  hasAttachments?: boolean;
};

export async function route(
  prompt: string,
  connectedToolkits: Set<string>,
  ctx: RouteContext = {},
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

  // Build the shortlist from the active prompt PLUS recent conversation so
  // follow-ups like "just send him hi" still surface SEND_EMAIL / contacts /
  // calendar tools rather than only matching the active prompt's tokens.
  const shortlistInput = ctx.recentTurns ? `${prompt}\n${ctx.recentTurns}` : prompt;
  const shortlist = await shortlistTools(shortlistInput, 50);

  const compact = shortlist
    .map((t) => `- ${t.slug} [${t.toolkit}]: ${(t.description || "").slice(0, 140)}`)
    .join("\n");

  const contextBlock = ctx.recentTurns
    ? `Recent conversation (for context — the ACTIVE prompt is the last user turn):\n${ctx.recentTurns}\n\n`
    : "";
  const attachBlock = ctx.hasAttachments
    ? `\n\nNOTE: the user has already uploaded files via the UI on a prior turn. They are STILL available for this turn. If the active prompt is a short follow-up to a send-email flow (e.g. a bare email address, "just send him hi", "subject is X"), classify it as send_email and continue the existing draft.`
    : "";

  const userMsg = `${contextBlock}Active user prompt:\n"""${prompt}"""${attachBlock}\n\nShortlist:\n${compact || "(no clearly-relevant tools matched)"}\n\nReturn JSON only.`;

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
  console.log(
    `[router] intent=${obj.intent} model-picked=[${modelSelected.join(", ") || "(none)"}]`,
  );

  // Intent-based filter (the safety layer the user asked for)
  const filtered = filterToolsByIntent(obj.intent, modelSelected);
  let selected = filtered.allowed;
  const blocked = filtered.blocked;
  if (filtered.blocked.length) {
    console.log(
      `[router] filter blocked [${filtered.blocked.map((b) => b.slug).join(", ")}]`,
    );
  }

  // Stage 1 recovery: re-shortlist-filter for action intents.
  const actionIntents = new Set([
    "email_triage",
    "send_email",
    "calendar_schedule",
    "github_read",
  ]);
  if (
    selected.length === 0 &&
    actionIntents.has(obj.intent) &&
    obj.mode !== "clarify"
  ) {
    const recovered = filterToolsByIntent(
      obj.intent,
      shortlist.map((t) => t.slug),
    );
    const top = recovered.allowed.slice(0, 3);
    if (top.length > 0) {
      console.log(
        `[router] recovery stage-1: model picked nothing → top filtered shortlist [${top.join(", ")}]`,
      );
      selected = top;
    }
  }

  // Stage 2 recovery: deterministic backstops by intent. These are what make
  // each action path executable even when the LLM is unhelpful.
  if (selected.length === 0 && obj.intent === "email_triage") {
    const best = (await getBestEmailReadTools()).slice(0, 2);
    if (best.length > 0) {
      selected = best.map((t) => t.slug);
      console.log(
        `[router] recovery stage-2: injecting deterministic email read tools [${selected.join(", ")}]`,
      );
    }
  }
  if (obj.intent === "send_email") {
    const hasSend = selected.some((s) => /SEND_EMAIL/.test(s.toUpperCase()));
    if (!hasSend) {
      const best = (await getBestSendEmailTools()).slice(0, 1);
      if (best.length > 0) {
        selected = [best[0]!.slug, ...selected.filter((s) => s !== best[0]!.slug)];
        console.log(
          `[router] recovery stage-2: injecting send-email tool [${best[0]!.slug}]`,
        );
      }
    }
    // If the conversation references a person by name and has no email
    // address anywhere, also surface a contacts search tool so the agent can
    // resolve the recipient before calling SEND_EMAIL.
    const fullText = `${prompt}\n${ctx.recentTurns ?? ""}`;
    const hasEmailAddr = /\S+@\S+\.\S+/.test(fullText);
    const namePattern =
      /\b(?:send|email|mail|forward|reply)\s+(?:this|that|it|him|her|them|to)\s+([a-z][a-z'\s]{1,30})\b/i;
    const altNamePattern =
      /\b(?:to|with)\s+([a-z][a-z'-]{1,25})\b(?!\s*@)/i;
    const looksLikeName =
      namePattern.test(fullText) || altNamePattern.test(fullText);
    if (!hasEmailAddr && looksLikeName) {
      const hasContact = selected.some((s) =>
        /(SEARCH_PEOPLE|GET_PEOPLE|GET_CONTACTS|DIRECTORY)/.test(s.toUpperCase()),
      );
      if (!hasContact) {
        const best = (await getBestContactsSearchTools()).slice(0, 1);
        if (best.length > 0) {
          selected = [best[0]!.slug, ...selected];
          console.log(
            `[router] recovery stage-2: injecting contacts tool [${best[0]!.slug}] for send_email — partial name detected, no email present`,
          );
        }
      }
    }
  }
  if (obj.intent === "github_read") {
    const hasIssueReadTool = selected.some((s) =>
      /^GITHUB_(LIST|SEARCH|GET).*ISSUE/.test(s),
    );
    if (!hasIssueReadTool) {
      const best = (await getBestGitHubIssueReadTools()).slice(0, 2);
      if (best.length > 0) {
        const seen = new Set(selected);
        for (const t of best) if (!seen.has(t.slug)) selected.push(t.slug);
        console.log(
          `[router] recovery stage-2: injecting github issue-read tools [${best.map((t) => t.slug).join(", ")}]`,
        );
      }
    }
  }
  if (obj.intent === "calendar_schedule") {
    // If the prompt mentions an attendee by name and we have no '@email'
    // already, ensure a contacts/people search tool is in the toolset so the
    // agent can resolve the email before creating the event.
    const ev = extractEventSlots(prompt);
    const promptHasEmail = /@/.test(prompt);
    if (ev.attendees.length && !promptHasEmail) {
      const hasContactTool = selected.some((s) =>
        /(SEARCH_PEOPLE|GET_PEOPLE|GET_CONTACTS)/.test(s),
      );
      if (!hasContactTool) {
        const best = (await getBestContactsSearchTools()).slice(0, 1);
        if (best.length > 0) {
          selected = [best[0]!.slug, ...selected];
          console.log(
            `[router] recovery stage-2: injecting contacts search tool [${best[0]!.slug}] because attendees=[${ev.attendees.join(", ")}] and no email in prompt`,
          );
        }
      }
    }
  }

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

  let jobType: JobType =
    obj.job_type === "none" ? null : (obj.job_type as JobType);

  // Hard guard: long_job requires explicit sheet/spreadsheet output.
  // Without it, the model often misclassifies "summarize 5 issues" as long_job.
  const lower = prompt.toLowerCase();
  const mentionsSheet = /\b(sheet|spreadsheet|csv)\b/.test(lower);
  let demotedMode: typeof obj.mode = obj.mode;
  if (obj.mode === "long_job" && !mentionsSheet) {
    console.log(
      `[router] demoting long_job → interactive (prompt has no "sheet"/"spreadsheet" output target)`,
    );
    demotedMode = "interactive";
    jobType = null;
  }
  obj.mode = demotedMode;

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
