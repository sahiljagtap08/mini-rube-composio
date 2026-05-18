// Intent profiles constrain which tools the router/executor will actually use
// for a given prompt. Slugs are matched (uppercased) against `allow` and `deny`
// regex lists. A slug must (a) not match any deny pattern, and (b) if `allow`
// is non-empty, match at least one allow pattern.
//
// `readonly: true` flags intents that must NEVER produce side effects. The tool
// executor double-checks this and refuses to run any tool whose slug looks
// mutating, even if it somehow slipped through the router filter.
//
// Profiles are deliberately broad (matching capability families, not specific
// slugs) so adding new toolkits later just works.

export type Intent =
  | "conversational"
  | "email_triage"
  | "send_email"
  | "calendar_schedule"
  | "github_issues_to_sheet"
  | "drive_files_to_sheet"
  | "other";

export type IntentProfile = {
  description: string;
  allow: RegExp[];
  deny: RegExp[];
  readonly?: boolean;
  noTools?: boolean;
  // Restrict tool selection to slugs whose toolkit prefix is in this list.
  // Tool slugs from Composio follow `<TOOLKIT>_*` (uppercased) so we infer
  // by splitting on the first `_`.
  toolkits?: string[];
};

export const INTENT_PROFILES: Record<Intent, IntentProfile> = {
  conversational: {
    description: "Greeting, small talk, or capability question. No tools.",
    allow: [],
    deny: [/.*/],
    noTools: true,
  },
  email_triage: {
    description:
      "Read-only Gmail: list, search, summarize, surface important messages.",
    allow: [
      /FETCH/,
      /LIST/,
      /SEARCH/,
      /\bGET\b/,
      /READ/,
      /MESSAGES?/,
      /THREADS?/,
      /SNIPPET/,
      /LABELS_LIST/,
      /PROFILE/,
    ],
    deny: [
      /SEND/,
      /MODIFY/,
      /BATCH_/,
      /ADD_LABEL/,
      /REMOVE_LABEL/,
      /APPLY_LABEL/,
      /DELETE/,
      /TRASH/,
      /ARCHIVE/,
      /CREATE_DRAFT/,
      /UPDATE_DRAFT/,
      /\bDRAFT\b/,
      /\bREPLY\b/,
      /FORWARD/,
      /UPDATE/,
      /MARK_/,
      /MOVE_/,
      /STAR_/,
      /UNSTAR_/,
      /NOTIFICATIONS/,
      /IMPORT/,
      /WATCH/,
    ],
    readonly: true,
    toolkits: ["googlesuper"],
  },
  send_email: {
    description: "Compose and send one email (optionally with attachment).",
    allow: [
      /SEND/,
      /DRAFT/,
      /COMPOSE/,
      /CREATE_EMAIL/,
      /CREATE_MAIL/,
      /MAIL_SEND/,
      /EMAIL_SEND/,
      /ATTACHMENT/,
    ],
    deny: [
      /DELETE/,
      /TRASH/,
      /ARCHIVE/,
      /ADD_LABEL/,
      /REMOVE_LABEL/,
      /MODIFY_LABEL/,
      /MOVE_TO_TRASH/,
      /MARK_AS/,
    ],
    toolkits: ["googlesuper"],
  },
  calendar_schedule: {
    description:
      "Create a calendar event, possibly resolving a partial name via contacts/people.",
    allow: [
      /CALENDAR/,
      /EVENT/,
      /SCHEDULE/,
      /CREATE/,
      /INSERT/,
      /CONTACT/,
      /PEOPLE/,
      /DIRECTORY/,
      /SEARCH/,
      /FIND/,
      /LIST/,
      /\bGET\b/,
    ],
    deny: [/DELETE/, /CANCEL/, /REMOVE/, /CLEAR/],
    toolkits: ["googlesuper"],
  },
  github_issues_to_sheet: {
    description:
      "Bulk: enumerate GitHub issues for a repo and write rows into a Google Sheet.",
    allow: [
      /ISSUE/,
      /LIST/,
      /SEARCH/,
      /\bGET\b/,
      /SHEET/,
      /SPREADSHEET/,
      /APPEND/,
      /BATCH_UPDATE/,
      /BATCH_GET/,
      /CREATE_SPREADSHEET/,
    ],
    deny: [/DELETE/, /CLOSE_ISSUE/, /LOCK/, /TRANSFER/, /REMOVE/],
  },
  drive_files_to_sheet: {
    description:
      "Bulk: enumerate Drive folder, extract per-file data, write rows into a Sheet.",
    allow: [
      /DRIVE/,
      /LIST/,
      /\bGET\b/,
      /DOWNLOAD/,
      /EXPORT/,
      /SHEET/,
      /SPREADSHEET/,
      /APPEND/,
      /BATCH_UPDATE/,
      /CREATE_SPREADSHEET/,
    ],
    deny: [
      /DELETE/,
      /TRASH/,
      /MOVE/,
      /CREATE_FOLDER/,
      /UPLOAD/,
      /UPDATE_FILE/,
      /PERMISSION/,
      /SHARE/,
    ],
  },
  other: {
    description: "Anything else. Defaults to read-only.",
    allow: [/.*/],
    deny: [/DELETE/, /TRASH/, /REMOVE/, /CANCEL/],
  },
};

// Composio slugs use UNDERSCORE-separated tokens. JS regex `\b` treats `_` as
// a word char, so we tokenize on non-letters instead and check whole tokens.
const MUTATING_TOKENS = new Set([
  "SEND",
  "CREATE",
  "UPDATE",
  "DELETE",
  "ADD",
  "REMOVE",
  "MODIFY",
  "TRASH",
  "ARCHIVE",
  "REPLY",
  "FORWARD",
  "CLOSE",
  "CANCEL",
  "LOCK",
  "TRANSFER",
  "INSERT",
  "DRAFT",
  "CLEAR",
  "UPLOAD",
  "APPLY",
  "PUT",
  "IMPORT",
  "PATCH",
  "DUPLICATE",
  "COPY",
  "EDIT",
  "MOVE",
  "EMPTY",
  "WATCH",
]);

export function isMutating(slug: string): boolean {
  const up = slug.toUpperCase();
  if (up.includes("MARK_AS")) return true;
  const tokens = up.split(/[^A-Z]+/);
  return tokens.some((t) => MUTATING_TOKENS.has(t));
}

export function isReadOnlyIntent(intent: Intent): boolean {
  return !!INTENT_PROFILES[intent].readonly;
}

export type ToolFilter = {
  allowed: string[];
  blocked: Array<{ slug: string; reason: string }>;
};

function toolkitOfSlug(slug: string): string {
  const i = slug.indexOf("_");
  return (i > 0 ? slug.slice(0, i) : slug).toLowerCase();
}

export function filterToolsByIntent(intent: Intent, slugs: string[]): ToolFilter {
  const p = INTENT_PROFILES[intent];
  if (p.noTools) {
    return {
      allowed: [],
      blocked: slugs.map((s) => ({
        slug: s,
        reason: `intent="${intent}" disallows tools`,
      })),
    };
  }
  const allowed: string[] = [];
  const blocked: Array<{ slug: string; reason: string }> = [];
  for (const s of slugs) {
    const up = s.toUpperCase();
    if (p.toolkits && !p.toolkits.includes(toolkitOfSlug(s))) {
      blocked.push({
        slug: s,
        reason: `intent="${intent}" only allows toolkits [${p.toolkits.join(", ")}]`,
      });
      continue;
    }
    const deniedBy = p.deny.find((rx) => rx.test(up));
    if (deniedBy) {
      blocked.push({
        slug: s,
        reason: `intent="${intent}" deny match ${deniedBy}`,
      });
      continue;
    }
    if (p.allow.length && !p.allow.some((rx) => rx.test(up))) {
      blocked.push({
        slug: s,
        reason: `intent="${intent}" — no allow-pattern match`,
      });
      continue;
    }
    allowed.push(s);
  }
  return { allowed, blocked };
}

// --- placeholder detection -------------------------------------------------
// Block obvious hallucinated IDs. We can't catch every made-up value, but we
// can reject the well-known LLM dummies and the textbook placeholder shapes.

const PLACEHOLDER_RX: RegExp[] = [
  /^1a2b3c4d5e6f7890$/i,
  /^0+$/,
  /^1+$/,
  /^(abc|xyz)[\d_-]*$/i,
  /^(example|test|placeholder|dummy|sample|foo|bar|baz)[_-]?(id|value|name|address)?$/i,
  /^123(?:456)?(?:789)?$/,
  /^[a-z]+_id$/i,
  /^(your|the|some|any|user)[_-]?(id|email|name|value)?$/i,
  /^<[^>]+>$/,
  /^\{[^}]+\}$/,
];

const ID_FIELD_RX = /(^|_)(id|ids|message_id|thread_id|event_id|file_id|folder_id|spreadsheet_id|sheet_id|user_id|to|cc|bcc|email|recipient)(_|$)/i;

export function findPlaceholders(
  args: unknown,
): Array<{ path: string; value: string }> {
  const out: Array<{ path: string; value: string }> = [];
  const looksFake = (v: string) =>
    PLACEHOLDER_RX.some((rx) => rx.test(v.trim()));
  function walk(node: unknown, path: string, parentKey: string) {
    if (node == null) return;
    if (typeof node === "string") {
      // only flag if parent key looks like an id/recipient or value looks like a placeholder template
      if (looksFake(node) || (ID_FIELD_RX.test(parentKey) && looksFake(node))) {
        out.push({ path: path || parentKey, value: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, parentKey));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, k);
      }
    }
  }
  walk(args, "", "");
  return out;
}
