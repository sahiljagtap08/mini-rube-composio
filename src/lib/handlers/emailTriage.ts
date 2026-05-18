// Deterministic email_triage handler. Bypasses the generic streamText tool
// loop because Composio's FETCH_EMAILS returns full bodies + base64
// attachments — passing that back into the model context = instant 128K
// overflow. Instead we fetch lean, sanitize, rank in code, and only feed the
// model a compact top-N for natural-language wording.

import { executeTool } from "../tools";
import { extractEmailSlots } from "../slots";

export type SanitizedEmail = {
  id?: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  labels?: string[];
  unread?: boolean;
  hasAttachments?: boolean;
  attachmentNames?: string[];
};

export type RankedEmail = SanitizedEmail & { _score: number };

export type TriageStats = {
  requestedCount: number;
  fetchArgs: Record<string, unknown>;
  rawSize: number;
  sanitizedSize: number;
  fetched: number;
  ranked: number;
  topCount: number;
  finalPayloadSize: number;
  tokenGuardApplied: boolean;
  durationMs: number;
};

export type TriageResult = {
  topEmails: RankedEmail[];
  stats: TriageStats;
  error?: string;
};

// --- sanitization --------------------------------------------------------

const KEEP_HEADERS = new Set(["from", "to", "cc", "subject", "date"]);

function extractHeader(raw: any, name: string): string | undefined {
  const headers = raw?.payload?.headers ?? raw?.headers;
  if (Array.isArray(headers)) {
    const lname = name.toLowerCase();
    const h = headers.find((x: any) => String(x?.name ?? "").toLowerCase() === lname);
    if (h?.value) return String(h.value);
  }
  return undefined;
}

function firstStr(...vals: any[]): string | undefined {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s.length > 0) return s;
  }
  return undefined;
}

function dropOversize(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

export function sanitizeEmail(raw: any): SanitizedEmail {
  if (!raw || typeof raw !== "object") return {};
  const out: SanitizedEmail = {};

  out.id = firstStr(raw.id, raw.messageId, raw.message_id, raw.gmail_id, raw.gmailId);
  out.threadId = firstStr(raw.threadId, raw.thread_id);

  out.from = dropOversize(
    firstStr(
      raw.from,
      raw.sender,
      raw.fromEmail,
      raw.from_address,
      raw.From,
      extractHeader(raw, "from"),
    ),
    300,
  );
  out.to = dropOversize(
    firstStr(raw.to, raw.toEmail, raw.to_address, extractHeader(raw, "to")),
    300,
  );
  out.subject = dropOversize(
    firstStr(raw.subject, raw.title, extractHeader(raw, "subject")),
    300,
  );
  out.date = dropOversize(
    firstStr(
      raw.date,
      raw.internalDate,
      raw.internal_date,
      raw.receivedAt,
      raw.received_at,
      extractHeader(raw, "date"),
    ),
    100,
  );
  out.snippet = dropOversize(firstStr(raw.snippet, raw.preview), 300);

  const labels = raw.labels ?? raw.labelIds ?? raw.label_ids;
  if (Array.isArray(labels)) {
    out.labels = labels.map((l) => String(l)).slice(0, 25);
    if (out.labels.includes("UNREAD")) out.unread = true;
  }

  const atts = raw.attachments ?? raw.attachment ?? [];
  if (Array.isArray(atts) && atts.length > 0) {
    out.hasAttachments = true;
    out.attachmentNames = atts
      .map((a: any) =>
        dropOversize(firstStr(a?.filename, a?.name, "attachment"), 120) ?? "attachment",
      )
      .slice(0, 10);
  }

  // Drop anything we accidentally pulled in — body, payload, raw MIME etc.
  // Done by virtue of explicit field-picking above; nothing else is included.
  void KEEP_HEADERS;
  return out;
}

export function sanitizeEmailResult(raw: any): SanitizedEmail[] {
  const data = raw?.data ?? raw;
  const candidates =
    data?.messages ??
    data?.emails ??
    data?.items ??
    data?.results ??
    (Array.isArray(data) ? data : []);
  if (!Array.isArray(candidates)) return [];
  const out: SanitizedEmail[] = [];
  for (const item of candidates) out.push(sanitizeEmail(item));
  return out;
}

// --- ranking -------------------------------------------------------------

const URGENT_WORDS =
  /\b(urgent|action|interview|offer|invoice|payment|deadline|meeting|cpt|opt|internship|account|on hold|signup|verify|verification|2fa|otp|alert|invitation|invite|response|reply\s+by|attention|reminder|expires|expiring)\b/i;
const NEWSLETTER_WORDS =
  /\b(newsletter|unsubscribe|promo|deal|sale|coupon|digest|weekly|monthly|update from|notifications?|noreply|no-reply|do_not_reply|donotreply|marketing|recommended|trending|liked your|commented on|posted on|sponsored)\b/i;
const BOT_SENDER =
  /(?:^|<)\s*(?:no-?reply|noreply|do-?not-?reply|donotreply|notifications?|alerts?|news|info|hello|support|team|updates?|marketing|hi|community)@/i;

export function scoreEmail(e: SanitizedEmail): number {
  let s = 0;
  const labels = (e.labels ?? []).map((l) => l.toUpperCase());
  if (labels.includes("IMPORTANT")) s += 5;
  if (labels.includes("STARRED")) s += 4;
  if (labels.includes("UNREAD") || e.unread) s += 3;

  const sender = (e.from ?? "").toLowerCase();
  const haystack = `${e.subject ?? ""} ${e.snippet ?? ""}`;
  const realPerson = sender && !BOT_SENDER.test(sender);
  if (realPerson) s += 2;
  if (URGENT_WORDS.test(haystack)) s += 2;
  if (NEWSLETTER_WORDS.test(haystack) || BOT_SENDER.test(sender)) s -= 3;
  if (e.hasAttachments) s += 1;
  return s;
}

export function rankEmails(emails: SanitizedEmail[]): RankedEmail[] {
  return emails
    .map((e) => ({ ...e, _score: scoreEmail(e) }))
    .sort((a, b) => b._score - a._score);
}

// --- runner --------------------------------------------------------------

const FINAL_PAYLOAD_CAP = 40_000;

export async function runEmailTriage(
  prompt: string,
  userId: string,
): Promise<TriageResult> {
  const started = Date.now();
  const slots = extractEmailSlots(prompt);
  const lower = prompt.toLowerCase();
  // Only use the Gmail-side `is:important` filter when the user explicitly
  // asks for important-only WITHOUT a recency-bounded sample. The
  // "last 100 emails and show important ones" prompt wants us to inspect the
  // recent 100 and rank — NOT only fetch is:important.
  const explicitImportantOnly = /\bonly\b.*\b(important|starred)\b/i.test(lower);
  const hasRecencyWindow = /\b(last|latest|recent|past|previous)\b/i.test(lower);
  const useImportantQuery =
    explicitImportantOnly ||
    (slots.importantOnly && !hasRecencyWindow && slots.count <= 25);

  const maxResults = Math.max(1, Math.min(slots.count, 100));
  const args: Record<string, unknown> = {
    max_results: maxResults,
    include_payload: false,
    verbose: false,
  };
  if (useImportantQuery) {
    args.query = "is:important OR is:starred";
  } else if (slots.gmailQuery && !hasRecencyWindow) {
    // Only apply slot-derived filters when the user did NOT ask for a
    // recency window. For "last 100 emails and show important ones" we want
    // the recent 100 unfiltered, then rank in code.
    args.query = slots.gmailQuery;
  }

  console.log(
    `[email_triage] requested=${slots.count} max_results=${maxResults} useImportantQuery=${useImportantQuery} args=${JSON.stringify(args)}`,
  );

  let raw: any;
  try {
    raw = await executeTool("GOOGLESUPER_FETCH_EMAILS", userId, args);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[email_triage] fetch failed: ${msg}`);
    return {
      topEmails: [],
      stats: {
        requestedCount: slots.count,
        fetchArgs: args,
        rawSize: 0,
        sanitizedSize: 0,
        fetched: 0,
        ranked: 0,
        topCount: 0,
        finalPayloadSize: 0,
        tokenGuardApplied: false,
        durationMs: Date.now() - started,
      },
      error: msg,
    };
  }

  // Composio shape: { successful, error, data }
  if (raw && raw.successful === false) {
    const msg = raw.error ?? "FETCH_EMAILS reported failure";
    console.error(`[email_triage] tool failure: ${msg}`);
    return {
      topEmails: [],
      stats: {
        requestedCount: slots.count,
        fetchArgs: args,
        rawSize: JSON.stringify(raw).length,
        sanitizedSize: 0,
        fetched: 0,
        ranked: 0,
        topCount: 0,
        finalPayloadSize: 0,
        tokenGuardApplied: false,
        durationMs: Date.now() - started,
      },
      error: msg,
    };
  }

  const rawSize = JSON.stringify(raw).length;
  const sanitized = sanitizeEmailResult(raw);
  const sanitizedSize = JSON.stringify(sanitized).length;
  const ranked = rankEmails(sanitized);

  // Top-N policy:
  // - explicit-important-only request → return top up to user's count (or 20)
  // - default ("show me the important ones") → top 10
  const topRequested = explicitImportantOnly
    ? Math.min(ranked.length, Math.max(5, slots.count))
    : Math.min(10, ranked.length);
  let top = ranked.slice(0, topRequested);

  // Token guard
  let finalPayload = JSON.stringify(top);
  let guardApplied = false;
  while (finalPayload.length > FINAL_PAYLOAD_CAP && top.length > 1) {
    top = top.slice(0, Math.max(1, Math.floor(top.length * 0.7)));
    finalPayload = JSON.stringify(top);
    guardApplied = true;
  }
  if (finalPayload.length > FINAL_PAYLOAD_CAP) {
    top = top.map((e) => ({
      ...e,
      snippet: e.snippet ? e.snippet.slice(0, 80) : undefined,
    }));
    finalPayload = JSON.stringify(top);
    guardApplied = true;
  }

  console.log(
    `[email_triage] raw=${rawSize}B sanitized=${sanitizedSize}B fetched=${sanitized.length} ranked=${ranked.length} top=${top.length} final=${finalPayload.length}B guard=${guardApplied}`,
  );

  return {
    topEmails: top,
    stats: {
      requestedCount: slots.count,
      fetchArgs: args,
      rawSize,
      sanitizedSize,
      fetched: sanitized.length,
      ranked: ranked.length,
      topCount: top.length,
      finalPayloadSize: finalPayload.length,
      tokenGuardApplied: guardApplied,
      durationMs: Date.now() - started,
    },
  };
}
