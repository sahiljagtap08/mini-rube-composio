// Maps Composio tool slugs to human-friendly run-step labels. Patterns are
// matched in order; first hit wins. Fallback turns the slug into Title Case.

const KNOWN: Array<[RegExp, string]> = [
  [/FETCH_EMAILS\b/, "Fetching emails"],
  [/FETCH_MESSAGE/, "Fetching email"],
  [/LIST_MESSAGES|LIST_THREADS/, "Listing emails"],
  [/SEARCH_PEOPLE|GET_PEOPLE|GET_CONTACTS/, "Searching contacts"],
  [/SEND_EMAIL/, "Sending email"],
  [/CREATE_EMAIL_DRAFT|CREATE_DRAFT/, "Drafting email"],
  [/FORWARD_MESSAGE/, "Forwarding email"],
  [/CREATE_EVENT|EVENT_INSERT/, "Creating calendar event"],
  [/EVENTS_LIST|EVENTS_GET/, "Reading calendar"],
  [/LIST_REPOSITORY_ISSUES|SEARCH_ISSUES_AND_PULL_REQUESTS/, "Reading GitHub issues"],
  [/GET_AN_ISSUE/, "Getting GitHub issue"],
  [/LIST_PULL_REQUESTS|GET_A_PULL_REQUEST/, "Reading pull requests"],
  [/CREATE_SPREADSHEET|CREATE_GOOGLE_SHEET/, "Creating Google Sheet"],
  [/SPREADSHEET_ROW|APPEND/, "Writing rows to Sheet"],
  [/BATCH_UPDATE/, "Batch update Sheet"],
  [/DOWNLOAD_FILE/, "Downloading file"],
  [/LIST_CHILDREN|LIST_FILES|FILES_LIST/, "Listing files"],
];

export function labelForTool(slug: string): string {
  const up = slug.toUpperCase();
  for (const [rx, label] of KNOWN) if (rx.test(up)) return label;
  return slug
    .replace(/^(GITHUB|GOOGLESUPER)_/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
