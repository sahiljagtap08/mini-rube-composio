// Long-job: enumerate every file in a Google Drive folder, extract
// {name, university, last_job} per file, and write all rows into a new
// Google Sheet. Uses the dep-graph chain:
//
//   GOOGLESUPER_LIST_CHILDREN_V2  (produces file_id list)
//   → GOOGLESUPER_DOWNLOAD_FILE   (consumes file_id, produces text)
//   → LLM extract per file        (in-code, small per-call payload)
//   → GOOGLESUPER_CREATE_GOOGLE_SHEET1  (produces spreadsheet_id)
//   → GOOGLESUPER_BATCH_UPDATE    (consumes spreadsheet_id + rows)
//
// Per-file extraction uses generateObject with a tiny schema so the model
// only ever sees one resume's text at a time — context can't blow up no
// matter how many files are in the folder. PDF text extraction relies on
// whatever Composio's DOWNLOAD_FILE returns; if a file is a binary PDF
// without server-side extraction, we record a partial row and continue.

import { generateObject, jsonSchema } from "ai";
import { executeTool } from "../tools";
import { emit, type Job } from "../jobs";
import { model } from "../ai";
import { describeChain } from "../depGraph";

const CONCURRENCY = 4;
const SHEET_BATCH_ROWS = 100;
const HEADERS = ["Filename", "Candidate Name", "University", "Last Job", "Source File"];

function parseFolderId(prompt: string): string | null {
  // Match /drive/folders/<id> or /folders/<id>
  const a = /folders\/([A-Za-z0-9_-]{10,})/i.exec(prompt);
  if (a) return a[1]!;
  // Bare folder id token (44+ chars typical)
  const b = /\b([A-Za-z0-9_-]{28,})\b/.exec(prompt);
  return b ? b[1]! : null;
}

type ExtractedFields = {
  name: string;
  university: string;
  last_job: string;
};

const EXTRACT_SCHEMA = jsonSchema<ExtractedFields>({
  type: "object",
  required: ["name", "university", "last_job"],
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Candidate full name as it appears at the top of the resume. Empty string if not found." },
    university: { type: "string", description: "Most recent or highest-ranked university/college. Empty string if not found." },
    last_job: { type: "string", description: "Most recent job title and company, e.g. 'Software Engineer at Stripe'. Empty string if not found." },
  },
});

const EXTRACT_SYSTEM = `You read one resume at a time and extract three fields: candidate's full name, most recent (or highest-degree) university, and most recent job title with company.

Rules:
- If a field is not clearly present, return the empty string. Do NOT guess.
- Trim leading "Mr.", "Ms.", "Dr." from the name only if it's a title prefix; keep the rest verbatim.
- "Last job" should read like "<Title> at <Company>" when both are clear; otherwise just the company name or just the title.
- Do not invent universities or employers.`;

async function extractOne(text: string): Promise<ExtractedFields> {
  // Cap input — most resumes fit easily; we slice to keep one bad file
  // (e.g. a 200-page PDF) from running up costs.
  const sample = text.slice(0, 8000);
  try {
    const res = await generateObject({
      model,
      schema: EXTRACT_SCHEMA,
      mode: "json",
      system: EXTRACT_SYSTEM,
      prompt: `Resume:\n"""\n${sample}\n"""\n\nReturn JSON.`,
    });
    return res.object;
  } catch {
    return { name: "", university: "", last_job: "" };
  }
}

function pickText(downloadResult: any): { text: string; mimeType?: string } {
  const data = downloadResult?.data ?? downloadResult ?? {};
  const text =
    data?.text ??
    data?.content ??
    data?.body ??
    data?.preview ??
    data?.extracted_text ??
    "";
  return { text: typeof text === "string" ? text : "", mimeType: data?.mimeType ?? data?.mime_type };
}

async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const idx = next++;
        if (idx >= items.length) return;
        out[idx] = await worker(items[idx]!, idx);
      }
    }),
  );
  return out;
}

export async function runDriveFilesToSheet(
  job: Job,
  userId: string,
  prompt: string,
): Promise<void> {
  try {
    const folderId = parseFolderId(prompt);
    if (!folderId) {
      emit(job, {
        kind: "error",
        error: "I couldn't find a Drive folder ID in your prompt. Paste the folder URL (https://drive.google.com/drive/folders/<id>).",
      });
      return;
    }
    // LIST_CHILDREN_V2 only returns id-only references — we need full
    // metadata (name, mimeType) so we use FIND_FILE with a folder_id filter.
    const chain = [
      "GOOGLESUPER_FIND_FILE",
      "GOOGLESUPER_DOWNLOAD_FILE",
      "GOOGLESUPER_CREATE_GOOGLE_SHEET1",
      "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
    ];
    emit(job, { kind: "plan", chain, note: `folder ${folderId}` });
    console.log(`[drive→sheet] plan: ${describeChain(chain)} folder=${folderId}`);

    // ---- Phase 1: list files in folder ----
    // FIND_FILE returns full metadata (name, mimeType, webViewLink). The
    // alternative LIST_CHILDREN_V2 only returns id-only references.
    emit(job, { kind: "step", label: `Listing files in Drive folder ${folderId}` });
    let allFiles: any[] = [];
    let pageToken: string | undefined;
    let page = 0;
    while (page < 50) {
      const res: any = await executeTool("GOOGLESUPER_FIND_FILE", userId, {
        folder_id: folderId,
        pageSize: 100,
        pageToken,
      });
      if (res?.successful === false) {
        emit(job, { kind: "error", error: `Drive list failed: ${res.error}` });
        return;
      }
      const data = res?.data ?? res;
      const files = data?.files ?? data?.items ?? (Array.isArray(data) ? data : []);
      if (!Array.isArray(files)) break;
      allFiles.push(...files);
      pageToken = data?.nextPageToken ?? data?.next_page_token;
      emit(job, {
        kind: "progress",
        processed: allFiles.length,
        total: null,
        message: `${allFiles.length} files listed`,
      });
      if (!pageToken || files.length === 0) break;
      page += 1;
    }
    if (allFiles.length === 0) {
      emit(job, {
        kind: "done",
        result: { filesCount: 0, note: "No files found in that folder." },
      });
      return;
    }
    emit(job, {
      kind: "step",
      label: `Found ${allFiles.length} file${allFiles.length === 1 ? "" : "s"}. Extracting in parallel (concurrency=${CONCURRENCY})…`,
    });

    // ---- Phase 2: download + extract per file ----
    let extracted = 0;
    const rows: (string | number)[][] = [HEADERS];
    type Outcome = { filename: string; fields: ExtractedFields; sourceUrl: string };
    const outcomes = await processBatch<any, Outcome>(allFiles, CONCURRENCY, async (f) => {
      const fileId = f.id ?? f.file_id ?? f.fileId ?? "";
      const filename = f.name ?? f.title ?? "(unnamed)";
      const sourceUrl =
        f.webViewLink ?? f.web_view_link ?? f.url ?? (fileId ? `https://drive.google.com/file/d/${fileId}/view` : "");
      let text = "";
      try {
        const dl: any = await executeTool("GOOGLESUPER_DOWNLOAD_FILE", userId, {
          file_id: fileId,
          fileId,
        });
        if (dl?.successful !== false) {
          ({ text } = pickText(dl));
        }
      } catch {
        /* swallow per-file errors; we'll record an empty extraction */
      }
      const fields = text
        ? await extractOne(text)
        : { name: "", university: "", last_job: "" };
      extracted += 1;
      emit(job, {
        kind: "progress",
        processed: extracted,
        total: allFiles.length,
        message: filename,
      });
      return { filename, fields, sourceUrl };
    });
    for (const o of outcomes) {
      rows.push([
        o.filename,
        o.fields.name,
        o.fields.university,
        o.fields.last_job,
        o.sourceUrl,
      ]);
    }

    // ---- Phase 3: create sheet ----
    const sheetTitle = `mini-rube · Drive candidates · ${new Date().toISOString().slice(0, 10)}`;
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
        error: "Sheet was created but no spreadsheet_id was returned.",
      });
      return;
    }
    emit(job, { kind: "step", label: "Sheet created", detail: spreadsheetId });

    // ---- Phase 4: append rows in batches ----
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
        total: rows.length,
        message: `Wrote ${wroteTotal}/${rows.length} rows`,
      });
    }

    emit(job, {
      kind: "done",
      result: {
        spreadsheetId,
        sheetUrl,
        sheetTitle,
        filesCount: allFiles.length,
        rowsWritten: rows.length - 1,
        folderId,
      },
    });
  } catch (err: any) {
    emit(job, { kind: "error", error: err?.message ?? String(err) });
  }
}
