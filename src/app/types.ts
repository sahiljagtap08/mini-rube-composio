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
