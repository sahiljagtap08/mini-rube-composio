import { randomUUID } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

export type Upload = {
  id: string;
  path: string;
  filename: string;
  mime: string;
  size: number;
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
