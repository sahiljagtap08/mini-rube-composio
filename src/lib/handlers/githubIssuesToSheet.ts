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
import { emit, type Job } from "../jobs";
import { describeChain } from "../depGraph";

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
      emit(job, {
        kind: "error",
        error: "I couldn't find an owner/repo in your prompt. Try 'composiohq/composio'.",
      });
      return;
    }
    const state = parseState(prompt);
    const countLimit = parseCountLimit(prompt);
    const chain = [
      "GITHUB_LIST_REPOSITORY_ISSUES",
      "GOOGLESUPER_CREATE_GOOGLE_SHEET1",
      "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
    ];
    emit(job, {
      kind: "plan",
      chain,
      note: `${repo.owner}/${repo.repo}, state=${state}${countLimit ? `, limit=${countLimit}` : ""}`,
    });
    console.log(
      `[github→sheet] plan: ${describeChain(chain)} (${repo.owner}/${repo.repo} ${state}${countLimit ? ` limit=${countLimit}` : ""})`,
    );

    // ---- Phase 1: paginate issues ----
    const allIssues: any[] = [];
    let page = 1;
    const targetCount = countLimit ?? Infinity;
    while (page <= MAX_PAGES && allIssues.length < targetCount) {
      emit(job, {
        kind: "step",
        label: `Fetching ${repo.owner}/${repo.repo} issues, page ${page}`,
      });
      const res: any = await executeTool("GITHUB_LIST_REPOSITORY_ISSUES", userId, {
        owner: repo.owner,
        repo: repo.repo,
        state,
        per_page: ISSUES_PER_PAGE,
        page,
      });
      if (res?.successful === false) {
        emit(job, {
          kind: "error",
          error: `GitHub list failed on page ${page}: ${res.error ?? "unknown"}`,
        });
        return;
      }
      const data = res?.data ?? res;
      let pageItems: any[] = [];
      if (Array.isArray(data?.issues)) pageItems = data.issues;
      else if (Array.isArray(data?.items)) pageItems = data.items;
      else if (Array.isArray(data)) pageItems = data;
      else if (Array.isArray(data?.response)) pageItems = data.response;
      if (pageItems.length === 0) break;
      // GitHub returns PRs as issues with a pull_request field — exclude them
      const onlyIssues = pageItems.filter((i: any) => !i?.pull_request);
      for (const issue of onlyIssues) {
        if (allIssues.length >= targetCount) break;
        allIssues.push(issue);
      }
      emit(job, {
        kind: "progress",
        processed: allIssues.length,
        total: countLimit,
        message: `${allIssues.length} issues fetched`,
      });
      if (pageItems.length < ISSUES_PER_PAGE) break;
      if (allIssues.length >= targetCount) break;
      page += 1;
    }
    emit(job, {
      kind: "step",
      label: `Fetched ${allIssues.length} issues from ${repo.owner}/${repo.repo}`,
    });

    if (allIssues.length === 0) {
      emit(job, {
        kind: "done",
        result: { issuesCount: 0, note: "No issues matched the filter — nothing to write." },
      });
      return;
    }

    // ---- Phase 2: create the sheet ----
    const sheetTitle = `mini-rube · ${repo.owner}/${repo.repo} issues · ${new Date()
      .toISOString()
      .slice(0, 10)}`;
    emit(job, { kind: "step", label: `Creating Google Sheet "${sheetTitle}"` });
    const createRes: any = await executeTool(
      "GOOGLESUPER_CREATE_GOOGLE_SHEET1",
      userId,
      { title: sheetTitle },
    );
    if (createRes?.successful === false) {
      emit(job, { kind: "error", error: `Couldn't create sheet: ${createRes.error}` });
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
      emit(job, {
        kind: "error",
        error: "Sheet was created but the response didn't include a spreadsheet_id.",
      });
      return;
    }
    emit(job, {
      kind: "step",
      label: `Sheet created`,
      detail: spreadsheetId,
    });

    // ---- Phase 3: append rows in batches ----
    const rows: (string | number)[][] = [HEADERS];
    for (const i of allIssues) rows.push(rowOf(i));
    const total = rows.length;

    let wroteTotal = 0;
    for (let offset = 0; offset < rows.length; offset += SHEET_BATCH_ROWS) {
      const batch = rows.slice(offset, offset + SHEET_BATCH_ROWS);
      // SPREADSHEETS_VALUES_APPEND with table-anchored range — Sheets will
      // find the last row of the logical table at A1 and append after it.
      const appendArgs = {
        spreadsheetId,
        range: "Sheet1!A1",
        valueInputOption: "RAW",
        values: batch,
      };
      const ar: any = await executeTool(
        "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
        userId,
        appendArgs,
      );
      if (ar?.successful === false) {
        emit(job, {
          kind: "error",
          error: `Sheet append failed at row ${offset}: ${ar.error}`,
        });
        return;
      }
      wroteTotal += batch.length;
      emit(job, {
        kind: "progress",
        processed: wroteTotal,
        total,
        message: `Wrote ${wroteTotal}/${total} rows`,
      });
    }

    emit(job, {
      kind: "done",
      result: {
        spreadsheetId,
        sheetUrl,
        sheetTitle,
        issuesCount: allIssues.length,
        state,
        repo: `${repo.owner}/${repo.repo}`,
      },
    });
  } catch (err: any) {
    emit(job, { kind: "error", error: err?.message ?? String(err) });
  }
}
