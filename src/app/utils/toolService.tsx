import {
  CalendarIcon,
  ContactsIcon,
  DocsIcon,
  DriveIcon,
  GenericToolIcon,
  GitHubIcon,
  GmailIcon,
  SheetsIcon,
  SparklesIcon,
} from "../components/serviceIcons";

export type Service =
  | "gmail"
  | "calendar"
  | "drive"
  | "sheets"
  | "docs"
  | "contacts"
  | "github"
  | "rank"
  | "generic";

// First-match-wins. Each rule maps a slug pattern to a service + human label.
const RULES: Array<[RegExp, Service, string]> = [
  // gmail
  [/FETCH_EMAILS\b/, "gmail", "Fetching emails"],
  [/FETCH_MESSAGE/, "gmail", "Fetching email"],
  [/LIST_MESSAGES|LIST_THREADS/, "gmail", "Listing emails"],
  [/SEND_EMAIL/, "gmail", "Sending email"],
  [/CREATE_EMAIL_DRAFT|CREATE_DRAFT/, "gmail", "Drafting email"],
  [/FORWARD_MESSAGE/, "gmail", "Forwarding email"],
  [/CREATE_REPLY/, "gmail", "Replying"],
  // contacts/people
  [/SEARCH_PEOPLE|GET_PEOPLE|GET_CONTACTS|DIRECTORY/, "contacts", "Searching contacts"],
  // calendar
  [/CREATE_EVENT|EVENT_INSERT/, "calendar", "Creating calendar event"],
  [/CALENDAR_LIST_INSERT/, "calendar", "Adding calendar"],
  [/EVENTS_LIST|EVENTS_GET|CALENDAR_LIST/, "calendar", "Reading calendar"],
  [/QUICK_ADD/, "calendar", "Quick-add event"],
  // sheets
  [/CREATE_GOOGLE_SHEET|CREATE_SPREADSHEET/, "sheets", "Creating Google Sheet"],
  [/SPREADSHEET_ROW|APPEND/, "sheets", "Appending rows"],
  [/BATCH_UPDATE/, "sheets", "Updating Sheet"],
  [/SHEET\b/, "sheets", "Working with Sheet"],
  // docs
  [/CREATE_DOCUMENT|GOOGLE_DOC/, "docs", "Creating Google Doc"],
  // drive
  [/DOWNLOAD_FILE|UPLOAD_FILE/, "drive", "Transferring file"],
  [/LIST_CHILDREN|LIST_FILES|FILES_LIST|FOLDER|DRIVE/, "drive", "Listing Drive files"],
  // github
  [/LIST_REPOSITORY_ISSUES/, "github", "Fetching GitHub issues"],
  [/SEARCH_ISSUES_AND_PULL_REQUESTS/, "github", "Searching GitHub"],
  [/GET_AN_ISSUE/, "github", "Reading GitHub issue"],
  [/LIST_PULL_REQUESTS|GET_A_PULL_REQUEST/, "github", "Fetching pull requests"],
  [/^GITHUB_/, "github", "GitHub action"],
];

export function describeTool(slug: string): { service: Service; label: string } {
  const up = slug.toUpperCase();
  for (const [rx, service, label] of RULES) {
    if (rx.test(up)) return { service, label };
  }
  return { service: "generic", label: prettify(slug) };
}

function prettify(slug: string): string {
  return slug
    .replace(/^(GITHUB|GOOGLESUPER)_/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ServiceIcon({ service }: { service: Service }) {
  switch (service) {
    case "gmail":
      return <GmailIcon />;
    case "calendar":
      return <CalendarIcon />;
    case "drive":
      return <DriveIcon />;
    case "sheets":
      return <SheetsIcon />;
    case "docs":
      return <DocsIcon />;
    case "contacts":
      return <ContactsIcon />;
    case "github":
      return <GitHubIcon />;
    case "rank":
      return <SparklesIcon />;
    default:
      return <GenericToolIcon />;
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
