export type RouteMeta = {
  kind?: string;
  mode?: string;
  intent?: string;
  tools?: string[];
  blocked?: Array<{ slug: string; reason: string }>;
  reason?: string;
  jobType?: string | null;
  provider?: string;
  model?: string;
  authToolkits?: string[] | null;
};

export type TriageStats = {
  kind?: "triage";
  requestedCount?: number;
  fetchArgs?: Record<string, unknown>;
  rawSize?: number;
  sanitizedSize?: number;
  fetched?: number;
  ranked?: number;
  topCount?: number;
  finalPayloadSize?: number;
  tokenGuardApplied?: boolean;
  durationMs?: number;
  error?: string;
};
