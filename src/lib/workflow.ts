// Generic workflow event model shared by every executor — interactive
// handlers (email_triage, calendar_schedule, send_email) and long-job
// background workers (github_issues_to_sheet, drive_files_to_sheet) emit
// the same events. The UI's <WorkflowChain> renders them uniformly.

export type ServiceTag =
  | "gmail"
  | "calendar"
  | "drive"
  | "sheets"
  | "docs"
  | "contacts"
  | "github"
  | "file"
  | "model"
  | "rank"
  | "generic";

export type StepStatus = "pending" | "active" | "done" | "error" | "skipped";

export type WorkflowStep = {
  id: string;
  label: string;
  service: ServiceTag;
  status: StepStatus;
  detail?: string;
  toolSlug?: string;
  startedAt?: number;
  endedAt?: number;
};

export type WorkflowResult = {
  sheetUrl?: string;
  rowsWritten?: number;
  eventLink?: string;
  summary?: string;
  [k: string]: unknown;
};

export type WorkflowEvent =
  | {
      kind: "workflow_started";
      title: string;
      steps: WorkflowStep[];
      jobId?: string;
    }
  | {
      kind: "workflow_step";
      stepId: string;
      status: StepStatus;
      detail?: string;
    }
  | {
      kind: "workflow_progress";
      current: number;
      total?: number;
      label?: string;
    }
  | { kind: "workflow_done"; result?: WorkflowResult }
  | { kind: "workflow_error"; message: string };

// Slug → step builder. Lets handlers that don't define explicit step lists
// derive a workflow from their selected tool slugs alone.
const SLUG_MAP: Array<[RegExp, ServiceTag, string]> = [
  [/FETCH_EMAILS|FETCH_MESSAGE|LIST_MESSAGES|LIST_THREADS/, "gmail", "Fetch emails"],
  [/SEND_EMAIL/, "gmail", "Send email"],
  [/CREATE_EMAIL_DRAFT|CREATE_DRAFT/, "gmail", "Draft email"],
  [/CREATE_REPLY|FORWARD_MESSAGE/, "gmail", "Reply / forward"],
  [/SEARCH_PEOPLE|GET_PEOPLE|GET_CONTACTS|DIRECTORY/, "contacts", "Search contacts"],
  [/CREATE_EVENT|EVENT_INSERT|QUICK_ADD/, "calendar", "Create calendar event"],
  [/EVENTS_LIST|EVENTS_GET|CALENDAR_LIST/, "calendar", "Read calendar"],
  [/CREATE_GOOGLE_SHEET|CREATE_SPREADSHEET/, "sheets", "Create Google Sheet"],
  [/SPREADSHEETS_VALUES_APPEND|SPREADSHEET_ROW|BATCH_UPDATE|APPEND/, "sheets", "Write rows to Sheet"],
  [/CREATE_DOCUMENT|GOOGLE_DOC/, "docs", "Create Google Doc"],
  [/DOWNLOAD_FILE|UPLOAD_FILE|EXPORT_FILE/, "drive", "Transfer file"],
  [/FIND_FILE|LIST_FILES|FILES_LIST|LIST_CHILDREN/, "drive", "Read Drive folder"],
  [/LIST_REPOSITORY_ISSUES/, "github", "Fetch GitHub issues"],
  [/SEARCH_ISSUES_AND_PULL_REQUESTS/, "github", "Search GitHub"],
  [/GET_AN_ISSUE/, "github", "Read GitHub issue"],
  [/LIST_PULL_REQUESTS|GET_A_PULL_REQUEST/, "github", "Read GitHub PRs"],
  [/^GITHUB_/, "github", "GitHub action"],
];

export function stepFromSlug(slug: string, id?: string): WorkflowStep {
  const up = slug.toUpperCase();
  for (const [rx, service, label] of SLUG_MAP) {
    if (rx.test(up)) {
      return {
        id: id ?? slug,
        label,
        service,
        status: "pending",
        toolSlug: slug,
      };
    }
  }
  return {
    id: id ?? slug,
    label: humanize(slug),
    service: "generic",
    status: "pending",
    toolSlug: slug,
  };
}

function humanize(slug: string): string {
  return slug
    .replace(/^(GITHUB|GOOGLESUPER)_/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Convenience builder used by every handler to define a workflow up-front.
export function step(
  id: string,
  label: string,
  service: ServiceTag,
  opts: { toolSlug?: string; status?: StepStatus } = {},
): WorkflowStep {
  return {
    id,
    label,
    service,
    status: opts.status ?? "pending",
    toolSlug: opts.toolSlug,
  };
}
