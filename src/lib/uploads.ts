import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { composio } from "./composio";

export type Upload = {
  id: string;
  path: string;
  filename: string;
  mime: string;
  size: number;
  // Populated lazily on first SEND_EMAIL call (or eagerly at upload time).
  // Composio's GMAIL/SEND_EMAIL needs {name, mimetype, s3key} — the s3key is
  // obtained by calling composio.files.upload(...) which stages the local
  // file in Composio's S3.
  s3key?: string;
  s3keyByTool?: Record<string, string>; // toolSlug → s3key (different tools may scope differently)
};

const DIR = path.join(tmpdir(), "mini-rube-uploads");
if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

const store = new Map<string, Upload>();

function safe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
}

export async function saveUpload(file: File): Promise<Upload> {
  const id = randomUUID();
  const fp = path.join(DIR, `${id}-${safe(file.name)}`);
  const buf = await file.arrayBuffer();
  await Bun.write(fp, buf);
  const u: Upload = {
    id,
    path: fp,
    filename: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
  };
  store.set(id, u);
  return u;
}

export function getUpload(id: string): Upload | undefined {
  return store.get(id);
}

export function uploadsDir(): string {
  return DIR;
}

// Stage a previously-saved local upload into Composio's S3 so it can be
// passed as an attachment to a Composio action. Caches the s3key per tool.
export async function ensureS3Key(
  upload: Upload,
  toolSlug: string,
  toolkitSlug: string,
): Promise<{ name: string; mimetype: string; s3key: string }> {
  upload.s3keyByTool = upload.s3keyByTool ?? {};
  const cached = upload.s3keyByTool[toolSlug];
  if (cached) {
    return { name: upload.filename, mimetype: upload.mime, s3key: cached };
  }
  const res = await (composio as any).files.upload({
    file: upload.path,
    toolSlug,
    toolkitSlug,
  });
  if (!res?.s3key) {
    throw new Error(
      `composio.files.upload returned no s3key for ${upload.filename}`,
    );
  }
  upload.s3keyByTool[toolSlug] = res.s3key;
  if (!upload.s3key) upload.s3key = res.s3key;
  return {
    name: res.name ?? upload.filename,
    mimetype: res.mimetype ?? upload.mime,
    s3key: res.s3key,
  };
}

export function listUploads(): Upload[] {
  return [...store.values()];
}
