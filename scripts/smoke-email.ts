// Focused smoke test for the email_triage path. Hits /api/route only —
// confirms the router picks a Gmail read tool and never selects mutating ones.

const HOST = process.env.HOST ?? "http://localhost:3001";

const MUTATING_RX =
  /(?:^|_)(?:ADD|SEND|DELETE|TRASH|ARCHIVE|MODIFY|UPDATE|DRAFT|REPLY|FORWARD|BATCH|MARK|MOVE|STAR|UNSTAR|LABEL|CREATE|INSERT|PATCH|REMOVE)(?:_|$)/;
const EMAIL_READ_RX =
  /(FETCH|SEARCH|LIST|\bGET\b)/;

const PROMPTS = [
  "last 5 emails",
  "show my latest 5 emails",
  "read my last 5 emails and show important ones",
  "read my last 100 emails and show me the important ones",
];

type R = {
  mode?: string;
  intent?: string;
  selectedToolSlugs?: string[];
  blockedToolSlugs?: Array<{ slug: string; reason: string }>;
  reason?: string;
};

let pass = 0;
let fail = 0;
for (const p of PROMPTS) {
  const res = await fetch(`${HOST}/api/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: p }),
  });
  const r = (await res.json()) as R;
  const tools = r.selectedToolSlugs ?? [];
  const issues: string[] = [];
  if (r.intent !== "email_triage") issues.push(`intent expected email_triage, got ${r.intent}`);
  if (r.mode !== "interactive") issues.push(`mode expected interactive, got ${r.mode}`);
  if (tools.length === 0) issues.push("selected tools is empty");
  for (const s of tools) {
    if (MUTATING_RX.test(s)) issues.push(`mutating tool selected: ${s}`);
    if (!EMAIL_READ_RX.test(s)) issues.push(`non-read-shaped tool selected: ${s}`);
  }
  const ok = issues.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  "${p}"`);
  console.log(`  intent: ${r.intent}   mode: ${r.mode}`);
  console.log(`  tools : [${tools.join(", ") || "(none)"}]`);
  if (r.reason) console.log(`  reason: ${r.reason}`);
  for (const i of issues) console.log(`  - ${i}`);
  console.log("");
  if (ok) pass++;
  else fail++;
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
