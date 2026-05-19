// A small, code-readable dependency graph over the Composio catalog. We don't
// need yesterday's full 5,200-edge LLM-extracted graph here — at chat time
// the planner only needs to know two things:
//
//   1. Is this slug a read / create / update / delete?
//      (gates the intent filter and the long-job planner.)
//   2. What entities does this slug *consume* and *produce*?
//      (lets the planner say: "to append rows you need spreadsheet_id; the
//      thing that produces spreadsheet_id is CREATE_GOOGLE_SHEET1; so the
//      plan is CREATE → APPEND.")
//
// Entity inference is intentionally heuristic. For consume, we look at the
// real JSON schema property names (since that's what the model will be asked
// to fill). For produce, we use slug patterns — Composio doesn't ship output
// schemas in a uniform shape, so we encode the common producers explicitly.

import type { ToolMeta } from "./catalog";

export type ToolKind = "read" | "create" | "update" | "delete" | "other";

const KIND_RULES: Array<[RegExp, ToolKind]> = [
  [/(?:^|_)(?:DELETE|TRASH|REMOVE|EMPTY)(?:_|$)/, "delete"],
  [/(?:^|_)(?:UPDATE|PATCH|MODIFY|REPLACE|MOVE)(?:_|$)/, "update"],
  [
    /(?:^|_)(?:CREATE|INSERT|ADD|SEND|APPEND|UPLOAD|REPLY|FORWARD|DRAFT|DUPLICATE|COPY|BATCH_UPDATE|IMPORT|MARK_AS|APPLY|STAR|UNSTAR|WATCH|UNWATCH|LOCK|UNLOCK|MERGE|FORK|TRANSFER|RENAME)(?:_|$)/,
    "create",
  ],
  [
    /(?:^|_)(?:LIST|GET|FETCH|SEARCH|READ|VIEW|EXPORT|DOWNLOAD|CHECK|RESOLVE|TYPEAHEAD)(?:_|$)/,
    "read",
  ],
];

export function classifyKind(slug: string): ToolKind {
  const up = slug.toUpperCase();
  for (const [rx, k] of KIND_RULES) if (rx.test(up)) return k;
  return "other";
}

// Canonical entity names. Synonyms collapse to one ID so producer ↔ consumer
// matching works regardless of param naming (`spreadsheetId` vs `spreadsheet_id`).
const SYNONYMS: Record<string, string> = {
  spreadsheetid: "spreadsheet_id",
  sheet_id: "sheet_id",
  sheetid: "sheet_id",
  fileid: "file_id",
  folderid: "folder_id",
  issuenumber: "issue_number",
  issue_number: "issue_number",
  messageid: "message_id",
  threadid: "thread_id",
  eventid: "event_id",
  calendarid: "calendar_id",
  pullnumber: "pull_number",
  pull_number: "pull_number",
  prnumber: "pull_number",
  draftid: "draft_id",
  labelid: "label_id",
  userid: "user_id",
  repository: "repo",
  reponame: "repo",
  ownername: "owner",
  resourcename: "resource_name",
  contactid: "contact_id",
  email: "contact_email",
  recipient_email: "contact_email",
  recipientemail: "contact_email",
};

const KNOWN_ENTITIES = [
  "spreadsheet_id",
  "sheet_id",
  "file_id",
  "folder_id",
  "issue_number",
  "pull_number",
  "message_id",
  "thread_id",
  "event_id",
  "calendar_id",
  "draft_id",
  "label_id",
  "user_id",
  "contact_email",
  "contact_id",
  "owner",
  "repo",
];

export function canonical(name: string): string {
  const lower = name.toLowerCase().replace(/-/g, "_");
  return SYNONYMS[lower] ?? lower;
}

export function consumesEntities(meta: ToolMeta): string[] {
  const out = new Set<string>();
  const props = (meta.inputSchema?.properties ?? {}) as Record<string, unknown>;
  for (const rawKey of Object.keys(props)) {
    const c = canonical(rawKey);
    if (KNOWN_ENTITIES.includes(c)) out.add(c);
    else {
      // Substring match for things like "spreadsheetId" inside a longer key
      for (const ent of KNOWN_ENTITIES) {
        if (c.includes(ent)) {
          out.add(ent);
          break;
        }
      }
    }
  }
  return [...out];
}

// Slug-pattern-based producer inference. Conservative: only patterns we've
// actually seen ship a usable producer for that entity.
const PRODUCER_PATTERNS: Array<[RegExp, string[]]> = [
  [/CREATE_GOOGLE_SHEET|CREATE_SPREADSHEET\b/, ["spreadsheet_id"]],
  [/CREATE_EVENT|EVENTS_INSERT/, ["event_id"]],
  [/CREATE_EMAIL_DRAFT|CREATE_DRAFT/, ["draft_id"]],
  [/CREATE_FOLDER\b/, ["folder_id"]],
  [/CREATE_FILE|UPLOAD_FILE|CREATE_FILE_FROM_TEXT/, ["file_id"]],
  [/LIST_REPOSITORY_ISSUES|SEARCH_ISSUES_AND_PULL_REQUESTS|GET_AN_ISSUE/, ["issue_number"]],
  [/LIST_PULL_REQUESTS|GET_A_PULL_REQUEST/, ["pull_number"]],
  [/FETCH_EMAILS|FETCH_MESSAGE_BY_(?:MESSAGE|THREAD)_ID|LIST_MESSAGES/, ["message_id", "thread_id"]],
  [/LIST_THREADS\b/, ["thread_id"]],
  [/EVENTS_LIST|EVENTS_GET/, ["event_id"]],
  [/LIST_CHILDREN|LIST_FILES|FILES_LIST/, ["file_id"]],
  [/SEARCH_PEOPLE|GET_PEOPLE|GET_CONTACTS/, ["contact_email", "contact_id"]],
  [/CREATE_LABEL\b/, ["label_id"]],
  [/LIST_LABELS\b/, ["label_id"]],
];

export function producesEntities(meta: ToolMeta): string[] {
  const out = new Set<string>();
  const up = meta.slug.toUpperCase();
  for (const [rx, ents] of PRODUCER_PATTERNS) {
    if (rx.test(up)) for (const e of ents) out.add(e);
  }
  return [...out];
}

export type ToolNode = {
  slug: string;
  toolkit: string;
  kind: ToolKind;
  produces: string[];
  consumes: string[];
};

export function buildNode(meta: ToolMeta): ToolNode {
  return {
    slug: meta.slug,
    toolkit: meta.toolkit,
    kind: classifyKind(meta.slug),
    produces: producesEntities(meta),
    consumes: consumesEntities(meta),
  };
}

// Compact plan-string used in logs and the chat's run-meta channel.
export function describeChain(slugs: string[]): string {
  return slugs.join(" → ");
}

// Given a target tool, walk back through produced/consumed entities to
// suggest a minimal upstream chain. Returns plan as an ordered list of
// slugs ending with `targetSlug`. Recursion bounded to depth 3 — enough
// for any realistic plan, prevents infinite cycles.
export function suggestChain(
  targetSlug: string,
  nodes: Map<string, ToolNode>,
  visited = new Set<string>(),
  depth = 0,
): string[] {
  if (depth > 3 || visited.has(targetSlug)) return [targetSlug];
  visited.add(targetSlug);
  const node = nodes.get(targetSlug);
  if (!node) return [targetSlug];

  const upstream: string[] = [];
  for (const entity of node.consumes) {
    // skip "ubiquitous" entities — these come from the user, not another tool.
    if (entity === "owner" || entity === "repo" || entity === "user_id") continue;
    // find best producer for this entity
    let bestProducer: ToolNode | null = null;
    for (const cand of nodes.values()) {
      if (cand.slug === targetSlug) continue;
      if (!cand.produces.includes(entity)) continue;
      // prefer same toolkit; prefer "read" kind (list/get) over "create"
      const score =
        (cand.toolkit === node.toolkit ? 1 : 0) + (cand.kind === "read" ? 2 : 0);
      const bestScore = bestProducer
        ? (bestProducer.toolkit === node.toolkit ? 1 : 0) +
          (bestProducer.kind === "read" ? 2 : 0)
        : -1;
      if (score > bestScore) bestProducer = cand;
    }
    if (bestProducer && !visited.has(bestProducer.slug)) {
      upstream.push(...suggestChain(bestProducer.slug, nodes, visited, depth + 1));
    }
  }
  return [...upstream, targetSlug];
}
