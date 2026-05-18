import { composio } from "./composio";

export type ToolMeta = {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  inputSchema: any;
};

const ALLOWED_TOOLKITS = ["googlesuper", "github"] as const;
export const TOOLKITS: readonly string[] = ALLOWED_TOOLKITS;

let catalogPromise: Promise<ToolMeta[]> | null = null;
let bySlug = new Map<string, ToolMeta>();
let byToolkit = new Map<string, ToolMeta[]>();

function inferToolkit(slug: string, raw: any): string {
  const tk =
    raw?.toolkit?.slug ??
    raw?.toolkit?.name ??
    raw?.toolkit ??
    raw?.appName ??
    raw?.app_name;
  if (tk && typeof tk === "string") return tk.toLowerCase();
  const lower = slug.toLowerCase();
  for (const t of ALLOWED_TOOLKITS) if (lower.startsWith(t)) return t;
  return "unknown";
}

async function loadCatalog(): Promise<ToolMeta[]> {
  const raw = await composio.tools.getRawComposioTools({
    toolkits: [...ALLOWED_TOOLKITS],
    limit: 1000,
  });
  const out: ToolMeta[] = [];
  for (const t of raw) {
    const slug: string | undefined = (t as any).slug ?? (t as any).name;
    if (!slug) continue;
    const toolkit = inferToolkit(slug, t);
    if (!ALLOWED_TOOLKITS.includes(toolkit as any)) continue;
    out.push({
      slug,
      toolkit,
      name: (t as any).name ?? slug,
      description: (t as any).description ?? "",
      inputSchema: (t as any).inputParameters ?? { type: "object", properties: {} },
    });
  }
  bySlug = new Map(out.map((t) => [t.slug, t]));
  byToolkit = new Map();
  for (const t of out) {
    const arr = byToolkit.get(t.toolkit) ?? [];
    arr.push(t);
    byToolkit.set(t.toolkit, arr);
  }
  console.log(
    `[catalog] loaded ${out.length} tools — ` +
      [...byToolkit.entries()].map(([k, v]) => `${k}:${v.length}`).join(", "),
  );
  return out;
}

export function getCatalog(): Promise<ToolMeta[]> {
  if (!catalogPromise) catalogPromise = loadCatalog().catch((err) => {
    catalogPromise = null;
    throw err;
  });
  return catalogPromise;
}

export async function getToolBySlug(slug: string): Promise<ToolMeta | undefined> {
  await getCatalog();
  return bySlug.get(slug);
}

export async function getToolsBySlugs(slugs: string[]): Promise<ToolMeta[]> {
  await getCatalog();
  const out: ToolMeta[] = [];
  const seen = new Set<string>();
  for (const s of slugs) {
    if (seen.has(s)) continue;
    const t = bySlug.get(s);
    if (t) {
      out.push(t);
      seen.add(s);
    }
  }
  return out;
}

const STOP = new Set([
  "a", "an", "the", "is", "are", "was", "were", "of", "to", "in", "for", "on",
  "with", "and", "or", "i", "you", "me", "my", "please", "can", "could",
  "this", "that", "it", "at", "by", "from", "as", "be", "into", "do", "does",
  "have", "has", "want", "need", "show", "give", "tell",
]);

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length >= 3 && !STOP.has(t),
  );
}

function wordBoundaryHit(haystack: string, needle: string): boolean {
  // require alphanum boundary on both sides to avoid "yo" matching "your"
  const i = haystack.indexOf(needle);
  if (i < 0) return false;
  const before = i === 0 ? "" : haystack[i - 1];
  const after = haystack[i + needle.length] ?? "";
  const isWord = (c: string) => /[a-z0-9]/i.test(c);
  return !isWord(before ?? "") && !isWord(after);
}

const ALIAS: Record<string, string[]> = {
  email: ["gmail", "mail", "message"],
  emails: ["gmail", "mail", "message"],
  inbox: ["gmail", "mail"],
  mail: ["gmail", "email"],
  calendar: ["event", "schedule", "meeting"],
  schedule: ["calendar", "event"],
  event: ["calendar"],
  events: ["calendar"],
  meeting: ["calendar", "event"],
  sheet: ["spreadsheet", "googlesheets", "sheets"],
  sheets: ["spreadsheet", "googlesheets"],
  spreadsheet: ["sheets", "googlesheets"],
  drive: ["googledrive", "file", "folder"],
  folder: ["drive", "googledrive"],
  file: ["drive", "googledrive"],
  files: ["drive", "googledrive"],
  doc: ["docs", "googledocs", "document"],
  docs: ["googledocs", "document"],
  resume: ["drive", "file", "pdf"],
  resumes: ["drive", "file", "pdf"],
  candidate: ["resume", "drive"],
  candidates: ["resume", "drive"],
  contact: ["contacts", "people", "directory"],
  contacts: ["people", "directory"],
  people: ["contacts", "directory"],
  attach: ["attachment", "attachments"],
  attached: ["attachment", "attachments", "file"],
  attachment: ["attach", "attachments"],
  pdf: ["attachment", "file"],
  tomorrow: ["calendar", "event"],
  today: ["calendar", "event"],
  invite: ["calendar", "event", "meeting"],
  important: ["gmail", "starred"],
  unread: ["gmail", "label"],
  search: ["query", "find"],
  reply: ["gmail", "email", "message"],
  draft: ["gmail", "email", "message"],
  github: ["repo", "repository", "issue", "pr", "pull"],
  repo: ["github", "repository"],
  repository: ["github", "repo"],
  issue: ["github", "issues"],
  issues: ["github", "issue"],
  pr: ["pull", "github"],
  pull: ["pr", "github"],
};

function expand(tokens: string[]): string[] {
  const out = new Set<string>(tokens);
  for (const t of tokens) for (const a of ALIAS[t] ?? []) out.add(a);
  return [...out];
}

// Verbs in the prompt drive which *action family* of slugs we boost. This
// prevents tools like ADD_LABEL from winning a read-style prompt just because
// they share keywords ("important", "email").
const READ_VERBS = [
  "read",
  "show",
  "list",
  "fetch",
  "search",
  "find",
  "view",
  "get",
  "summarize",
  "summary",
  "rank",
  "triage",
  "see",
  "check",
];
const SEND_VERBS = ["send", "compose", "email", "mail"];
const CREATE_VERBS = ["create", "schedule", "add", "book", "make", "set up", "setup"];
const DELETE_VERBS = ["delete", "remove", "cancel", "archive", "trash"];

// Underscore-aware boundaries (JS \b treats _ as a word char, which breaks
// matching against Composio slugs like GOOGLESUPER_BATCH_MODIFY_MESSAGES).
const READ_SLUG_RX = /(?:^|_)(?:FETCH|LIST|SEARCH|GET|READ|MESSAGES?|THREADS?|SNIPPET|PROFILE|VIEW)(?:_|$)/;
const SEND_SLUG_RX = /(?:^|_)(?:SEND|REPLY|FORWARD)(?:_|$)/;
const CREATE_SLUG_RX = /(?:^|_)(?:CREATE|INSERT|SCHEDULE|ADD)(?:_|$)/;
const DELETE_SLUG_RX = /(?:^|_)(?:DELETE|REMOVE|CANCEL|ARCHIVE|TRASH)(?:_|$)/;
const MUTATE_SLUG_RX = /(?:^|_)(?:SEND|CREATE|UPDATE|ADD|REMOVE|MODIFY|DELETE|TRASH|ARCHIVE|REPLY|FORWARD|MOVE|INSERT|APPLY|MARK_AS|CLOSE|CANCEL|LOCK|TRANSFER|UPLOAD|BATCH|STAR|UNSTAR|PATCH)(?:_|$)/;

function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

export async function shortlistTools(
  prompt: string,
  limit = 30,
): Promise<ToolMeta[]> {
  const cat = await getCatalog();
  const tokens = expand(tokenize(prompt));
  if (tokens.length === 0) return [];
  const lower = prompt.toLowerCase();
  const wantsRead = hasAny(lower, READ_VERBS);
  const wantsSend = hasAny(lower, SEND_VERBS);
  const wantsCreate = hasAny(lower, CREATE_VERBS);
  const wantsDelete = hasAny(lower, DELETE_VERBS);
  // "read my last 100 emails and show me the important ones" is read-only even
  // though it contains "email" (which overlaps SEND_VERBS via the alias). When
  // read verbs are present and there's no explicit "send", treat as read.
  const readOnly = wantsRead && !/\bsend\b/.test(lower) && !wantsCreate && !wantsDelete;

  const scored = cat.map((t) => {
    const slug = t.slug.toLowerCase();
    const slugUp = t.slug.toUpperCase();
    const desc = t.description.toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (wordBoundaryHit(slug, tok)) score += 3;
      else if (slug.includes(tok)) score += 1;
      if (wordBoundaryHit(desc, tok)) score += 1;
    }
    if (score === 0) return { t, score };
    // action-family boosts
    if (wantsRead && READ_SLUG_RX.test(slugUp)) score += 5;
    if (wantsSend && SEND_SLUG_RX.test(slugUp)) score += 5;
    if (wantsCreate && CREATE_SLUG_RX.test(slugUp)) score += 5;
    if (wantsDelete && DELETE_SLUG_RX.test(slugUp)) score += 5;
    // strong anti-boost: read-only intent must not surface mutating tools
    if (readOnly && MUTATE_SLUG_RX.test(slugUp)) score -= 8;
    // mild anti-boost: a non-send prompt shouldn't pick SEND tools
    if (!wantsSend && SEND_SLUG_RX.test(slugUp)) score -= 3;
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.filter((s) => s.score > 0);
  return hits.slice(0, limit).map((s) => s.t);
}

export async function getToolsByToolkit(toolkit: string): Promise<ToolMeta[]> {
  await getCatalog();
  return byToolkit.get(toolkit) ?? [];
}
