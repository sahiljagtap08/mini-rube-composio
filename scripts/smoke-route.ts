// Routing-only smoke test. Hits the local /api/route endpoint with each
// prompt and asserts the router classifies it sanely. No tools are executed,
// so this is safe to run against a fully connected account.
//
// Usage:
//   bun scripts/smoke-route.ts                # routing checks (default)
//   bun scripts/smoke-route.ts --json         # JSON output for CI
//   bun scripts/smoke-route.ts --host=http://localhost:3001

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    args.set(k!, v ?? "true");
  }
}
const HOST = args.get("host") ?? "http://localhost:3001";
const JSON_OUT = args.get("json") === "true";

const MUTATING_RX =
  /(?:^|_)(?:SEND|CREATE|UPDATE|ADD|REMOVE|MODIFY|DELETE|TRASH|ARCHIVE|REPLY|FORWARD|MOVE|INSERT|APPLY|MARK_AS|CLOSE|CANCEL|LOCK|TRANSFER|UPLOAD|BATCH|STAR|UNSTAR|PATCH)(?:_|$)/;

type Expect = {
  intent?: string;
  mode?: string;
  jobType?: string | null;
  noMutating?: boolean;
  noTools?: boolean;
  hasAny?: RegExp[]; // at least one selected tool must match each regex
};

type Case = { name: string; prompt: string; expect: Expect };

const CASES: Case[] = [
  {
    name: "greeting → conversational",
    prompt: "hi",
    expect: { intent: "conversational", mode: "interactive", noTools: true },
  },
  {
    name: "capability question → conversational",
    prompt: "what can you do?",
    expect: { intent: "conversational", mode: "interactive", noTools: true },
  },
  {
    name: "yo (very short greeting)",
    prompt: "yo",
    expect: { intent: "conversational", noTools: true },
  },
  {
    name: "email triage read-only",
    prompt: "read my last 5 emails and show me the important ones",
    expect: { intent: "email_triage", mode: "interactive", noMutating: true },
  },
  {
    name: "email triage 100 (the original failing prompt)",
    prompt: "read my last 100 emails and show me the important ones",
    expect: { intent: "email_triage", mode: "interactive", noMutating: true },
  },
  {
    name: "calendar schedule with partial name",
    prompt: "schedule a 30 minute calendar event tomorrow with karan",
    expect: { intent: "calendar_schedule", mode: "interactive" },
  },
  {
    name: "send email to self (controlled)",
    prompt:
      "send an email to me@example.com with subject 'mini-rube test' and body 'hi'",
    expect: { intent: "send_email", mode: "interactive" },
  },
  {
    name: "github issues read-only",
    prompt: "summarize the last 5 open issues from composiohq/composio",
    expect: { mode: "interactive", noMutating: true },
  },
  {
    name: "github issues → sheet (long job)",
    prompt:
      "read all open and closed issues from composiohq/composio and make a google sheet of the problems",
    expect: { mode: "long_job", jobType: "github_issues_to_sheet" },
  },
  {
    name: "drive resumes → sheet (long job)",
    prompt:
      "take all the resumes in this drive folder https://drive.google.com/drive/folders/abc and put name, university, last job into a google sheet",
    expect: { mode: "long_job", jobType: "drive_files_to_sheet" },
  },
];

type RouteResp = {
  mode?: string;
  intent?: string;
  selectedToolSlugs?: string[];
  blockedToolSlugs?: Array<{ slug: string; reason: string }>;
  jobType?: string | null;
  reason?: string;
  connected?: string[];
  errorMessage?: string;
  error?: string;
};

async function callRoute(prompt: string): Promise<RouteResp> {
  const res = await fetch(`${HOST}/api/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  return (await res.json()) as RouteResp;
}

type Result = {
  name: string;
  prompt: string;
  resp: RouteResp;
  failures: string[];
  ok: boolean;
};

function check(c: Case, resp: RouteResp): Result {
  const fails: string[] = [];
  const tools = resp.selectedToolSlugs ?? [];
  if (c.expect.intent && resp.intent !== c.expect.intent)
    fails.push(`intent: expected ${c.expect.intent}, got ${resp.intent}`);
  if (c.expect.mode && resp.mode !== c.expect.mode)
    fails.push(`mode: expected ${c.expect.mode}, got ${resp.mode}`);
  if (c.expect.jobType !== undefined && resp.jobType !== c.expect.jobType)
    fails.push(`jobType: expected ${c.expect.jobType}, got ${resp.jobType}`);
  if (c.expect.noTools && tools.length > 0)
    fails.push(`expected no tools, got [${tools.join(", ")}]`);
  if (c.expect.noMutating) {
    const muts = tools.filter((s) => MUTATING_RX.test(s));
    if (muts.length) fails.push(`mutating tools selected: ${muts.join(", ")}`);
  }
  if (c.expect.hasAny) {
    for (const rx of c.expect.hasAny) {
      if (!tools.some((s) => rx.test(s)))
        fails.push(`expected a tool matching ${rx}, got [${tools.join(", ")}]`);
    }
  }
  return { name: c.name, prompt: c.prompt, resp, failures: fails, ok: fails.length === 0 };
}

async function main() {
  // first check the server is up + connections
  let connStatus: any = null;
  try {
    const r = await fetch(`${HOST}/api/connections`);
    connStatus = await r.json();
  } catch (e: any) {
    console.error(`server unreachable at ${HOST}: ${e.message}`);
    process.exit(2);
  }
  if (!JSON_OUT) {
    console.log(`server: ${HOST}`);
    console.log(`connections: ${JSON.stringify(connStatus?.connected ?? {})}`);
    console.log("");
  }

  const results: Result[] = [];
  for (const c of CASES) {
    let resp: RouteResp;
    try {
      resp = await callRoute(c.prompt);
    } catch (e: any) {
      resp = { error: e.message };
    }
    const r = check(c, resp);
    results.push(r);
    if (JSON_OUT) continue;
    const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`  prompt:  "${c.prompt}"`);
    console.log(`  mode:    ${resp.mode}    intent: ${resp.intent}    job: ${resp.jobType ?? "-"}`);
    console.log(
      `  tools:   [${(resp.selectedToolSlugs ?? []).join(", ") || "(none)"}]`,
    );
    if ((resp.blockedToolSlugs ?? []).length) {
      console.log(
        `  blocked: [${(resp.blockedToolSlugs ?? [])
          .map((b) => b.slug)
          .join(", ")}]`,
      );
    }
    if (resp.reason) console.log(`  reason:  ${resp.reason}`);
    if (resp.errorMessage) console.log(`  err:     ${resp.errorMessage}`);
    for (const f of r.failures) console.log(`  - ${f}`);
    console.log("");
  }
  if (JSON_OUT) {
    console.log(JSON.stringify(results, null, 2));
  }
  const failed = results.filter((r) => !r.ok).length;
  if (!JSON_OUT) {
    console.log(`${results.length - failed} passed, ${failed} failed`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
