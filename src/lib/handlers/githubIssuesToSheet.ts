// Long-job: dump every issue (open + closed) in a GitHub repo into a
// Google Sheet. Designed to handle the 550-issue composiohq/composio case
// without blowing the model context — the entire flow is in code; the model
// is only used to detect intent on the original prompt.
//
// Dependency plan (built via depGraph.suggestChain at intent-detection time):
//   GITHUB_LIST_REPOSITORY_ISSUES               (produces issue_number, row data)
//   → GOOGLESUPER_CREATE_GOOGLE_SHEET1          (produces spreadsheet_id)
//   → GOOGLESUPER_SPREADSHEETS_VALUES_APPEND    (consumes spreadsheet_id + rows)
//
// Note: we originally targeted GOOGLESUPER_BATCH_UPDATE but Composio marks
// that tool DEPRECATED in favor of VALUES_APPEND, and the arg shape differs.
// Schema-probed args we use:
//   { spreadsheetId, range: "Sheet1!A1", valueInputOption: "RAW", values: [[...]] }

import { executeTool } from "../tools";
import {
  emit,
  workflowDone,
  workflowError,
  workflowProgress,
  workflowStep,
  type Job,
} from "../jobs";
import { step } from "../workflow";

const ISSUES_PER_PAGE = 100;
const SHEET_BATCH_ROWS = 200;
const MAX_PAGES = 50; // 5000-issue safety cap

const HEADERS = [
  "#",
  "Title",
  "State",
  "Author",
  "Created",
  "Updated",
  "Labels",
  "Body (preview)",
  "URL",
];

function parseRepo(prompt: string): { owner: string; repo: string } | null {
  const m = /\b([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\s*\/\s*([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\b/.exec(
    prompt,
  );
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

function parseCountLimit(prompt: string): number | null {
  // "last 10 open issues", "first 50 issues", "top 25 issues"
  const m =
    /(?:last|latest|first|top|recent)\s+(\d{1,4})\s+(?:open\s+|closed\s+)?(?:issues?|prs?|pull\s+requests?)/i.exec(
      prompt,
    );
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return null;
}

function parseState(prompt: string): "open" | "closed" | "all" {
  const lower = prompt.toLowerCase();
  if (/\bopen\s+and\s+closed|all\s+issues|every\s+issue|both/.test(lower)) return "all";
  if (/\bclosed\b/.test(lower) && !/\bopen\b/.test(lower)) return "closed";
  if (/\bopen\b/.test(lower) && !/\bclosed\b/.test(lower)) return "open";
  return "all";
}

function rowOf(issue: any): (string | number)[] {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l: any) => l?.name ?? l).filter(Boolean).join(", ")
    : "";
  const bodyPreview = String(issue.body ?? "")
    .slice(0, 240)
    .replace(/\s+/g, " ");
  return [
    issue.number ?? "",
    issue.title ?? "",
    issue.state ?? "",
    issue.user?.login ?? "",
    issue.created_at ?? "",
    issue.updated_at ?? "",
    labels,
    bodyPreview,
    issue.html_url ?? "",
  ];
}

export async function runGithubIssuesToSheet(
  job: Job,
  userId: string,
  prompt: string,
): Promise<void> {
  try {
    const repo = parseRepo(prompt);
    if (!repo) {
      workflowError(
        job,
        "I couldn't find an owner/repo in your prompt. Try 'composiohq/composio'.",
      );
      return;
    }
    const state = parseState(prompt);
    const countLimit = parseCountLimit(prompt);
    const STEPS = {
      FETCH: "fetch_issues",
      CREATE_SHEET: "create_sheet",
      WRITE_ROWS: "write_rows",
    };
    emit(job, {
      kind: "workflow_started",
      jobId: job.id,
      title: `Reading GitHub issues from ${repo.owner}/${repo.repo} → Google Sheet`,
      steps: [
        step(STEPS.FETCH, "Fetch GitHub issues", "github", {
          toolSlug: "GITHUB_LIST_REPOSITORY_ISSUES",
        }),
        step(STEPS.CREATE_SHEET, "Create Google Sheet", "sheets", {
          toolSlug: "GOOGLESUPER_CREATE_GOOGLE_SHEET1",
        }),
        step(STEPS.WRITE_ROWS, "Write issue rows to Sheet", "sheets", {
          toolSlug: "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
        }),
      ],
    });
    workflowStep(job, STEPS.FETCH, "active");

    // ---- Phase 1: paginate issues ----
    const allIssues: any[] = [];
    let page = 1;
    const targetCount = countLimit ?? Infinity;
    while (page <= MAX_PAGES && allIssues.length < targetCount) {
      const res: any = await executeTool("GITHUB_LIST_REPOSITORY_ISSUES", userId, {
        owner: repo.owner,
        repo: repo.repo,
        state,
        per_page: ISSUES_PER_PAGE,
        page,
      });
      if (res?.successful === false) {
        workflowStep(job, STEPS.FETCH, "error", `page ${page}: ${res.error ?? "unknown"}`);
        workflowError(job, `GitHub list failed on page ${page}: ${res.error ?? "unknown"}`);
        return;
      }
      const data = res?.data ?? res;
      let pageItems: any[] = [];
      if (Array.isArray(data?.issues)) pageItems = data.issues;
      else if (Array.isArray(data?.items)) pageItems = data.items;
      else if (Array.isArray(data)) pageItems = data;
      else if (Array.isArray(data?.response)) pageItems = data.response;
      if (pageItems.length === 0) break;
      const onlyIssues = pageItems.filter((i: any) => !i?.pull_request);
      for (const issue of onlyIssues) {
        if (allIssues.length >= targetCount) break;
        allIssues.push(issue);
      }
      workflowProgress(
        job,
        allIssues.length,
        countLimit ?? undefined,
        `Page ${page} · ${allIssues.length} issues fetched`,
      );
      if (pageItems.length < ISSUES_PER_PAGE) break;
      if (allIssues.length >= targetCount) break;
      page += 1;
    }
    workflowStep(
      job,
      STEPS.FETCH,
      "done",
      `${allIssues.length} issue${allIssues.length === 1 ? "" : "s"} fetched (PRs excluded)`,
    );

    if (allIssues.length === 0) {
      workflowStep(job, STEPS.CREATE_SHEET, "skipped");
      workflowStep(job, STEPS.WRITE_ROWS, "skipped");
      workflowDone(job, {
        summary: "No issues matched the filter — nothing to write.",
        rowsWritten: 0,
      });
      return;
    }

    // ---- Phase 2: create the sheet ----
    workflowStep(job, STEPS.CREATE_SHEET, "active");
    const sheetTitle = `mini-rube · ${repo.owner}/${repo.repo} issues · ${new Date()
      .toISOString()
      .slice(0, 10)}`;
    const createRes: any = await executeTool(
      "GOOGLESUPER_CREATE_GOOGLE_SHEET1",
      userId,
      { title: sheetTitle },
    );
    if (createRes?.successful === false) {
      workflowStep(job, STEPS.CREATE_SHEET, "error", createRes.error);
      workflowError(job, `Couldn't create sheet: ${createRes.error}`);
      return;
    }
    const sheetData = createRes?.data ?? createRes ?? {};
    const spreadsheetId =
      sheetData?.spreadsheetId ??
      sheetData?.spreadsheet_id ??
      sheetData?.id ??
      sheetData?.spreadsheet?.spreadsheetId ??
      null;
    const sheetUrl =
      sheetData?.spreadsheetUrl ??
      sheetData?.spreadsheet_url ??
      sheetData?.url ??
      (spreadsheetId
        ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`
        : null);
    if (!spreadsheetId) {
      workflowStep(job, STEPS.CREATE_SHEET, "error", "no spreadsheet_id in response");
      workflowError(job, "Sheet was created but the response didn't include a spreadsheet_id.");
      return;
    }
    workflowStep(job, STEPS.CREATE_SHEET, "done", sheetTitle);

    // ---- Phase 3: append rows in batches ----
    const rows: (string | number)[][] = [HEADERS];
    for (const i of allIssues) rows.push(rowOf(i));
    const total = rows.length;

    workflowStep(job, STEPS.WRITE_ROWS, "active");
    let wroteTotal = 0;
    for (let offset = 0; offset < rows.length; offset += SHEET_BATCH_ROWS) {
      const batch = rows.slice(offset, offset + SHEET_BATCH_ROWS);
      const ar: any = await executeTool(
        "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
        userId,
        {
          spreadsheetId,
          range: "Sheet1!A1",
          valueInputOption: "RAW",
          values: batch,
        },
      );
      if (ar?.successful === false) {
        workflowStep(job, STEPS.WRITE_ROWS, "error", `row ${offset}: ${ar.error}`);
        workflowError(job, `Sheet append failed at row ${offset}: ${ar.error}`);
        return;
      }
      wroteTotal += batch.length;
      workflowProgress(job, wroteTotal, total, `Wrote ${wroteTotal}/${total} rows`);
    }
    workflowStep(job, STEPS.WRITE_ROWS, "done", `${wroteTotal} rows`);

    workflowDone(job, {
      spreadsheetId,
      sheetUrl: sheetUrl ?? undefined,
      sheetTitle,
      issuesCount: allIssues.length,
      rowsWritten: wroteTotal,
      state,
      repo: `${repo.owner}/${repo.repo}`,
      summary: `Wrote ${allIssues.length} issues to ${sheetTitle}.`,
    });
  } catch (err: any) {
    workflowError(job, err?.message ?? String(err));
  }
}
