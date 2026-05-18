import {
  Mail,
  Calendar,
  FolderClosed,
  Sheet,
  FileText,
  Users,
  Wrench,
  Sparkles,
  Paperclip,
  Send,
} from "lucide-react";
import { GoogleGIcon, GitHubIcon } from "../components/serviceIcons";

export type Service =
  | "gmail"
  | "calendar"
  | "drive"
  | "sheets"
  | "docs"
  | "contacts"
  | "github"
  | "google"
  | "rank"
  | "attachment"
  | "send"
  | "generic";

const ICON_PROPS = { size: 18, strokeWidth: 1.7, "aria-hidden": true } as const;

export function ServiceIcon({ service }: { service: Service }) {
  switch (service) {
    case "gmail":
      return <Mail {...ICON_PROPS} color="#EA4335" />;
    case "calendar":
      return <Calendar {...ICON_PROPS} color="#1A73E8" />;
    case "drive":
      return <FolderClosed {...ICON_PROPS} color="#0F9D58" />;
    case "sheets":
      return <Sheet {...ICON_PROPS} color="#0F9D58" />;
    case "docs":
      return <FileText {...ICON_PROPS} color="#4285F4" />;
    case "contacts":
      return <Users {...ICON_PROPS} color="#5F6368" />;
    case "github":
      return <GitHubIcon />;
    case "google":
      return <GoogleGIcon />;
    case "rank":
      return <Sparkles {...ICON_PROPS} color="#7c3aed" />;
    case "attachment":
      return <Paperclip {...ICON_PROPS} color="#5F6368" />;
    case "send":
      return <Send {...ICON_PROPS} color="#EA4335" />;
    case "generic":
    default:
      return <Wrench {...ICON_PROPS} color="#71717a" />;
  }
}

// Tool slug → { service, label }. First rule wins.
const RULES: Array<[RegExp, Service, string]> = [
  // gmail
  [/FETCH_EMAILS\b/, "gmail", "Fetching emails"],
  [/FETCH_MESSAGE/, "gmail", "Fetching email"],
  [/LIST_MESSAGES|LIST_THREADS/, "gmail", "Listing emails"],
  [/SEND_EMAIL/, "gmail", "Sending email"],
  [/CREATE_EMAIL_DRAFT|CREATE_DRAFT/, "gmail", "Drafting email"],
  [/FORWARD_MESSAGE/, "gmail", "Forwarding email"],
  [/CREATE_REPLY/, "gmail", "Replying"],
  // contacts
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
  // fallback: any googlesuper tool we didn't pattern-match
  [/^GOOGLESUPER_/, "google", "Google action"],
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

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
