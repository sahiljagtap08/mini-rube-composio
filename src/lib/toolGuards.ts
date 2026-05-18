// Coerces tool arguments before execution and truncates tool results after
// execution so a single bad call can't blow the next model context.
//
// Background: GOOGLESUPER_FETCH_EMAILS defaults to include_payload:true +
// verbose:true. With max_results=100 that returns ~2.5M tokens — way over any
// reasonable context window. We force lean defaults here.

type Args = Record<string, unknown>;

const MAX_RESULT_BYTES = 80_000;

export function clampToolArgs(slug: string, args: Args): Args {
  const out: Args = { ...args };

  if (slug === "GOOGLESUPER_FETCH_EMAILS") {
    // Force lean payload — Composio's default include_payload:true / verbose:true
    // returns full bodies + base64 attachments which blows the model context.
    if (out.include_payload === undefined) out.include_payload = false;
    if (out.verbose === undefined) out.verbose = false;
    // Respect the user's requested count up to 100 (the assignment maximum).
    const mr = typeof out.max_results === "number" ? out.max_results : 10;
    out.max_results = Math.max(1, Math.min(mr, 100));
  }

  if (slug === "GOOGLESUPER_LIST_MESSAGES" || slug === "GOOGLESUPER_LIST_THREADS") {
    const mr = typeof out.max_results === "number" ? out.max_results : 25;
    out.max_results = Math.max(1, Math.min(mr, 100));
  }

  if (slug === "GITHUB_LIST_REPOSITORY_ISSUES" || slug === "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS") {
    const pp = typeof out.per_page === "number" ? out.per_page : 20;
    out.per_page = Math.max(1, Math.min(pp, 50));
  }

  return out;
}

// Truncate large tool results so the model doesn't ingest megabytes. We try to
// preserve the response shape so the model can still parse it.
export function clampToolResult(_slug: string, result: any): any {
  if (result == null) return result;
  try {
    const json = JSON.stringify(result);
    if (json.length <= MAX_RESULT_BYTES) return result;

    // Common Composio shape: { data: { messages: [...], nextPageToken } }
    const data = result?.data ?? result;
    const candidatePaths: Array<[string, any[]]> = [];
    for (const key of [
      "messages",
      "threads",
      "issues",
      "items",
      "files",
      "results",
      "events",
      "rows",
    ]) {
      if (Array.isArray(data?.[key])) candidatePaths.push([key, data[key]]);
    }

    if (candidatePaths.length > 0) {
      const [key, arr] = candidatePaths[0]!;
      const original = arr.length;
      // Estimate a safe cut by length / item-size
      const avgItem = json.length / Math.max(arr.length, 1);
      const safeCount = Math.max(5, Math.floor(MAX_RESULT_BYTES / avgItem));
      const truncated = arr.slice(0, safeCount).map((item) => stripHeavyFields(item));
      const newData = { ...data, [key]: truncated };
      newData._truncated = `Result was ${json.length} bytes (${original} items). Returning first ${truncated.length} items (heavy fields removed). Tell the user how many were retrieved.`;
      return result?.data ? { ...result, data: newData } : newData;
    }

    // Fallback: stringify and slice.
    return {
      _truncated: `Tool result was ${json.length} bytes — exceeds the ${MAX_RESULT_BYTES} byte guard. First ${MAX_RESULT_BYTES} chars only:`,
      preview: json.slice(0, MAX_RESULT_BYTES),
    };
  } catch {
    return result;
  }
}

// Drop fields known to be huge (raw bodies / base64 payloads) from each item.
function stripHeavyFields(item: any): any {
  if (!item || typeof item !== "object") return item;
  const HEAVY = new Set([
    "payload",
    "body",
    "raw",
    "rawBody",
    "rawContent",
    "html",
    "htmlContent",
    "text",
    "textContent",
    "messageText",
    "content",
    "attachments",
    "rawMessage",
  ]);
  const out: any = Array.isArray(item) ? [] : {};
  for (const [k, v] of Object.entries(item)) {
    if (HEAVY.has(k)) continue;
    if (typeof v === "string" && v.length > 2000) {
      out[k] = v.slice(0, 2000) + "…(truncated)";
    } else if (Array.isArray(v) && v.length > 25) {
      out[k] = v.slice(0, 25);
    } else {
      out[k] = v;
    }
  }
  return out;
}
