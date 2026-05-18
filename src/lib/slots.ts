// Lightweight slot extraction for prompts that have safe defaults. The intent
// is to push obvious values (count, filters, durations) into the system prompt
// so the agent can ACT instead of asking the user "would you like me to...".
//
// Generalizable per intent — adding a new intent just adds another extractor.

export type EmailSlots = {
  count: number; // 1..100
  importantOnly: boolean;
  unreadOnly: boolean;
  starredOnly: boolean;
  gmailQuery: string | null; // suggested Gmail search query
};

const NUM_RX = /(?:last|latest|recent|first|top|past|previous)\s+(\d{1,3})/i;
const RAW_NUM_NEAR_EMAILS = /(\d{1,3})\s*(?:emails?|messages?|mails?|threads?)/i;

export function extractEmailSlots(prompt: string): EmailSlots {
  const p = prompt.toLowerCase();
  let count = 10;
  const m1 = NUM_RX.exec(p);
  const m2 = RAW_NUM_NEAR_EMAILS.exec(p);
  const n = m1?.[1] ?? m2?.[1];
  if (n) {
    const parsed = parseInt(n, 10);
    if (!Number.isNaN(parsed) && parsed > 0) count = parsed;
  }
  count = Math.max(1, Math.min(count, 100));

  const importantOnly = /\bimportant\b/.test(p);
  const starredOnly = /\bstarred\b/.test(p);
  const unreadOnly = /\bunread\b/.test(p);

  let gmailQuery: string | null = null;
  const parts: string[] = [];
  if (unreadOnly) parts.push("is:unread");
  if (importantOnly && starredOnly) parts.push("(is:important OR is:starred)");
  else if (importantOnly) parts.push("is:important");
  else if (starredOnly) parts.push("is:starred");
  if (parts.length) gmailQuery = parts.join(" ");

  return { count, importantOnly, unreadOnly, starredOnly, gmailQuery };
}

export type EventSlots = {
  durationMinutes: number; // default 30
  date: string | null; // "tomorrow", explicit date, etc — agent resolves
  time: string | null; // null means ask
  attendees: string[]; // names mentioned after "with"
};

export function extractEventSlots(prompt: string): EventSlots {
  const p = prompt.toLowerCase();
  let durationMinutes = 30;
  const m = /(\d+)\s*(?:min(?:ute)?s?|hour|hr)s?/.exec(p);
  if (m && m[1]) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) {
      durationMinutes = /hour|hr/.test(m[0]) ? n * 60 : n;
    }
  }
  let date: string | null = null;
  if (/\btoday\b/.test(p)) date = "today";
  else if (/\btomorrow\b/.test(p)) date = "tomorrow";
  else if (/\bnext week\b/.test(p)) date = "next week";
  const timeRx = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
  const tm = timeRx.exec(prompt);
  const time = tm ? tm[0] : null;
  const attendees: string[] = [];
  const wm = /\bwith\s+([a-z][a-z'\s]{1,40})/i.exec(prompt);
  if (wm && wm[1]) attendees.push(wm[1].trim().split(/\s+(?:at|on|for|tomorrow|today|next)\b/i)[0]!.trim());
  return { durationMinutes, date, time, attendees };
}
