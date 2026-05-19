// Deterministic calendar_schedule handler. The generic streamText tool loop
// has a habit of fabricating event times ("scheduled for tomorrow at 3 PM"
// when the user said "in 5 mins") and claiming success without ever calling
// the tool. For a mutating action like CREATE_EVENT we cannot trust the LLM
// to be honest — every field is parsed in code, validated before the tool
// call, and the final answer is built from the tool result, not the model.

import { executeTool } from "../tools";

export type ParsedSlots = {
  title: string;
  start: Date | null;
  durationMinutes: number;
  attendeesEmails: string[];
  attendeeNames: string[]; // names not yet resolved to an email
  needsTime: boolean;
  wantedAttendee: boolean;
  wantsMeet: boolean;
  rawTimeMention: string | null;
};

const EMAIL_RX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const DURATION_RX = /(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/i;
const IN_REL_RX = /\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i;
const TOMORROW_AT_RX = /\btomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const TODAY_AT_RX = /\btoday\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const BARE_AT_RX = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const NEXT_DAY_RX = /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;
const TITLE_WORDS_RX = /\b(meeting|event|call|chat|sync|catchup|catch-up|interview|standup|1\s*on\s*1|1:1)\b/i;
const ATTENDEE_NAME_RX = /\bwith\s+([a-zA-Z][a-zA-Z'\s-]{1,30})/i;

function toHour(h: number, ampm: string | undefined): number {
  const am = ampm?.toLowerCase();
  if (am === "pm" && h < 12) return h + 12;
  if (am === "am" && h === 12) return 0;
  return h;
}

function clampMin(m: number | undefined): number {
  if (m == null || Number.isNaN(m)) return 0;
  return Math.max(0, Math.min(59, m));
}

export function parseEventSlots(prompt: string, now: Date = new Date()): ParsedSlots {
  // Emails (parse first — used by the title-match exclusion later)
  const emails = Array.from(prompt.match(EMAIL_RX) ?? []);

  // CRITICAL ORDER: parse relative start ("in 5 mins") BEFORE duration.
  // Otherwise the duration regex eats "5 minutes" from "in 5 minutes" and
  // we never see the start cue. We mask the matched substring before
  // duration parsing so the same number doesn't get reused.
  let start: Date | null = null;
  let rawTimeMention: string | null = null;
  let promptForDuration = prompt;

  const inRel = IN_REL_RX.exec(prompt);
  if (inRel) {
    const n = parseInt(inRel[1]!, 10);
    const unit = inRel[2]!.toLowerCase();
    let ms = 0;
    if (unit.startsWith("min")) ms = n * 60_000;
    else if (unit.startsWith("hour") || unit.startsWith("hr")) ms = n * 3_600_000;
    else if (unit.startsWith("day")) ms = n * 86_400_000;
    if (ms > 0) {
      start = new Date(now.getTime() + ms);
      rawTimeMention = inRel[0];
      // mask the "in N <unit>" substring so duration parsing ignores it
      promptForDuration = prompt.replace(inRel[0], " ".repeat(inRel[0].length));
    }
  }

  // Duration — default 30 min if not specified. Parsed from the masked
  // prompt so "in 5 mins" can't be mistakenly read as duration=5.
  let durationMinutes = 30;
  const dm = DURATION_RX.exec(promptForDuration);
  if (dm) {
    const n = parseInt(dm[1]!, 10);
    if (!Number.isNaN(n) && n > 0) {
      durationMinutes = /hour|hr/i.test(dm[2]!) ? n * 60 : n;
    }
  }

  if (!start) {
    const m = TOMORROW_AT_RX.exec(prompt);
    if (m) {
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      t.setHours(toHour(parseInt(m[1]!, 10), m[3]), clampMin(m[2] ? parseInt(m[2], 10) : 0), 0, 0);
      start = t;
      rawTimeMention = m[0];
    }
  }

  if (!start) {
    const m = TODAY_AT_RX.exec(prompt);
    if (m) {
      const t = new Date(now);
      t.setHours(toHour(parseInt(m[1]!, 10), m[3]), clampMin(m[2] ? parseInt(m[2], 10) : 0), 0, 0);
      // If the parsed time is already past, leave as-is — the agent should
      // either ask the user or push to tomorrow. We choose to ask by leaving
      // start null in that case to avoid silently scheduling in the past.
      if (t.getTime() > now.getTime()) {
        start = t;
        rawTimeMention = m[0];
      }
    }
  }

  if (!start) {
    const m = NEXT_DAY_RX.exec(prompt);
    if (m) {
      const dayNames = [
        "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
      ];
      const target = dayNames.indexOf(m[1]!.toLowerCase());
      if (target >= 0) {
        const t = new Date(now);
        const diff = (target - t.getDay() + 7) % 7 || 7;
        t.setDate(t.getDate() + diff);
        t.setHours(toHour(parseInt(m[2]!, 10), m[4]), clampMin(m[3] ? parseInt(m[3], 10) : 0), 0, 0);
        start = t;
        rawTimeMention = m[0];
      }
    }
  }

  if (!start) {
    const m = BARE_AT_RX.exec(prompt);
    if (m) {
      const t = new Date(now);
      t.setHours(toHour(parseInt(m[1]!, 10), m[3]), clampMin(m[2] ? parseInt(m[2], 10) : 0), 0, 0);
      if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
      start = t;
      rawTimeMention = m[0];
    }
  }

  // Title — derive from the kind of meeting if the user said it; otherwise default
  const tw = TITLE_WORDS_RX.exec(prompt);
  let title = "mini-rube meeting";
  if (tw) {
    const word = tw[0].toLowerCase().replace(/\s+/g, " ");
    title = `mini-rube ${word}`;
  }

  // Attendee — name (not an email) extracted from "with NAME"
  const attendeeNames: string[] = [];
  const nm = ATTENDEE_NAME_RX.exec(prompt);
  if (nm) {
    let candidate = nm[1]!.trim();
    // strip trailing scheduling words
    candidate = candidate
      .split(/\s+(?:tomorrow|today|next|at|on|in|by|for|via|@|about|regarding)\b/i)[0]!
      .trim();
    // strip trailing punctuation
    candidate = candidate.replace(/[.,;:!?]+$/, "").trim();
    if (candidate && !candidate.includes("@")) {
      const lower = candidate.toLowerCase();
      const firstTok = lower.split(/\s+/)[0]!;
      const overlap = emails.some((e) => e.toLowerCase().includes(firstTok));
      if (!overlap) attendeeNames.push(candidate);
    }
  }

  const wantedAttendee =
    /\bwith\s+/i.test(prompt) || emails.length > 0 || attendeeNames.length > 0;

  const wantsMeet =
    /\b(?:google\s+meet|meet\s+meeting|meet\s+link|video\s+call|video\s+meeting|videoconference|conference\s+call|hangout|with\s+meet)\b/i.test(
      prompt,
    );

  return {
    title,
    start,
    durationMinutes,
    attendeesEmails: emails,
    attendeeNames,
    needsTime: !start,
    wantedAttendee,
    wantsMeet,
    rawTimeMention,
  };
}

// --- contact sanitization -----------------------------------------------

export type Contact = { name: string; email: string };

export function sanitizeContacts(raw: any): Contact[] {
  const data = raw?.data ?? raw;
  const list =
    data?.results ??
    data?.people ??
    data?.contacts ??
    data?.connections ??
    data?.response ??
    (Array.isArray(data) ? data : []);
  const out: Contact[] = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    const person = item?.person ?? item;
    let name = "";
    if (Array.isArray(person?.names) && person.names[0]) {
      name = person.names[0].displayName ?? person.names[0].name ?? "";
    } else if (person?.name) {
      name = typeof person.name === "string" ? person.name : person.name.displayName ?? "";
    } else if (person?.displayName) {
      name = person.displayName;
    }
    let email = "";
    if (Array.isArray(person?.emailAddresses) && person.emailAddresses[0]) {
      email = person.emailAddresses[0].value ?? "";
    } else if (Array.isArray(person?.email_addresses) && person.email_addresses[0]) {
      const e = person.email_addresses[0];
      email = typeof e === "string" ? e : e.value ?? e.address ?? "";
    } else if (person?.email) {
      email = typeof person.email === "string" ? person.email : person.email.address ?? "";
    }
    if (email) out.push({ name: name || email, email });
  }
  return out;
}

// --- handler ------------------------------------------------------------

export type CalendarOutcome =
  | { status: "clarify"; message: string; slots: ParsedSlots; reason: string }
  | { status: "error"; message: string; slots: ParsedSlots; toolResult?: any }
  | {
      status: "success";
      slots: ParsedSlots;
      start: Date;
      end: Date;
      attendees: string[];
      toolResult: any;
      eventId?: string;
      eventLink?: string;
      meetLink?: string;
    };

const SEARCH_PEOPLE_SLUGS = [
  "GOOGLESUPER_SEARCH_PEOPLE",
  "GOOGLESUPER_GET_PEOPLE",
  "GOOGLESUPER_GET_CONTACTS",
];
const CREATE_EVENT_SLUG = "GOOGLESUPER_CREATE_EVENT";

async function searchContact(userId: string, name: string): Promise<Contact[]> {
  for (const slug of SEARCH_PEOPLE_SLUGS) {
    try {
      const res = await executeTool(slug, userId, { query: name, pageSize: 10 });
      if (!res || (res as any).successful === false) continue;
      const contacts = sanitizeContacts(res);
      if (contacts.length > 0) return contacts;
    } catch {
      /* try next slug */
    }
  }
  return [];
}

export async function runCalendarSchedule(
  prompt: string,
  combinedContext: string,
  userId: string,
  tz: string,
): Promise<CalendarOutcome> {
  const now = new Date();
  // We parse the union of the active prompt + recent context so multi-turn
  // flows like "schedule a meeting with karan" → "tomorrow at 3pm" still work.
  // But the active prompt's time/date takes precedence — parse it alone first.
  const primary = parseEventSlots(prompt, now);
  const combined = parseEventSlots(`${prompt}\n${combinedContext}`, now);

  const slots: ParsedSlots = {
    title: primary.title !== "mini-rube meeting" ? primary.title : combined.title,
    start: primary.start ?? combined.start,
    durationMinutes:
      primary.durationMinutes !== 30 ? primary.durationMinutes : combined.durationMinutes,
    attendeesEmails: Array.from(
      new Set([...primary.attendeesEmails, ...combined.attendeesEmails]),
    ),
    attendeeNames: Array.from(
      new Set([...primary.attendeeNames, ...combined.attendeeNames]),
    ),
    needsTime: !(primary.start ?? combined.start),
    wantedAttendee: primary.wantedAttendee || combined.wantedAttendee,
    wantsMeet: primary.wantsMeet || combined.wantsMeet,
    rawTimeMention: primary.rawTimeMention ?? combined.rawTimeMention,
  };

  console.log(
    `[calendar] parsed slots: start=${slots.start?.toISOString() ?? "(none)"} duration=${slots.durationMinutes}min emails=[${slots.attendeesEmails.join(",")}] names=[${slots.attendeeNames.join(",")}] title="${slots.title}"`,
  );

  // 1. Missing time → ask
  if (slots.needsTime) {
    return {
      status: "clarify",
      reason: "missing_time",
      message:
        "What time should I schedule it for? You can say something like 'in 30 minutes', 'tomorrow at 3pm', or 'today at 5pm'.",
      slots,
    };
  }

  // 2. Resolve attendee name → email if needed
  if (slots.attendeeNames.length > 0 && slots.attendeesEmails.length === 0) {
    const resolved: Array<{ name: string; email: string }> = [];
    const ambiguous: Array<{ name: string; candidates: Contact[] }> = [];
    const missing: string[] = [];
    for (const name of slots.attendeeNames) {
      const candidates = await searchContact(userId, name);
      // Filter to candidates whose name actually contains a token of the
      // searched name (avoid full-directory dumps).
      const tok = name.toLowerCase().split(/\s+/)[0]!;
      const filtered = candidates.filter(
        (c) => c.name.toLowerCase().includes(tok) || c.email.toLowerCase().includes(tok),
      );
      if (filtered.length === 1) {
        resolved.push({ name, email: filtered[0]!.email });
      } else if (filtered.length > 1) {
        ambiguous.push({ name, candidates: filtered.slice(0, 5) });
      } else {
        missing.push(name);
      }
    }
    if (ambiguous.length > 0) {
      const lines = ambiguous.map(
        (a) =>
          `**${a.name}** — multiple matches:\n${a.candidates
            .map((c) => `  - ${c.name} <${c.email}>`)
            .join("\n")}`,
      );
      return {
        status: "clarify",
        reason: "ambiguous_contact",
        message: `I found more than one contact for that name. Which should I invite?\n\n${lines.join("\n\n")}`,
        slots,
      };
    }
    if (missing.length > 0 && resolved.length === 0) {
      return {
        status: "clarify",
        reason: "no_contact_match",
        message: `I couldn't find a contact named "${missing.join(
          ", ",
        )}" in your Google Contacts. What's their email address?`,
        slots,
      };
    }
    slots.attendeesEmails.push(...resolved.map((r) => r.email));
  }

  // 3. Missing attendee when user clearly wanted one
  if (
    slots.wantedAttendee &&
    slots.attendeesEmails.length === 0 &&
    slots.attendeeNames.length === 0
  ) {
    return {
      status: "clarify",
      reason: "missing_attendee",
      message: "Who should I invite? Please share their email address.",
      slots,
    };
  }

  // 4. Build args and call the tool
  const start = slots.start!;
  const end = new Date(start.getTime() + slots.durationMinutes * 60_000);
  // Schema notes: event_duration_minutes is 0-59 ONLY. For ≥ 1h use
  // event_duration_hour. We always pass end_datetime which takes precedence
  // anyway, so duration fields are just defensive.
  const durHours = Math.floor(slots.durationMinutes / 60);
  const durMinutes = slots.durationMinutes % 60;
  const args: Record<string, unknown> = {
    summary: slots.title,
    start_datetime: start.toISOString(),
    end_datetime: end.toISOString(),
    event_duration_hour: durHours,
    event_duration_minutes: durMinutes,
    attendees: slots.attendeesEmails,
    timezone: tz,
    description: "Created by mini-rube",
    calendar_id: "primary",
    // Always create a Google Meet room when the user asked for one. The
    // Composio param defaults to true; we pass it explicitly so the
    // intent is unambiguous in the request.
    create_meeting_room: slots.wantsMeet,
  };
  console.log(`[calendar] calling ${CREATE_EVENT_SLUG} args=${JSON.stringify(args)}`);

  let result: any;
  try {
    result = await executeTool(CREATE_EVENT_SLUG, userId, args);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[calendar] tool threw:`, msg);
    return {
      status: "error",
      message: `I couldn't schedule the event: ${msg}`,
      slots,
    };
  }

  if (result && result.successful === false) {
    const msg = result.error ?? "tool reported failure";
    console.error(`[calendar] tool failed: ${msg}`);
    return {
      status: "error",
      message: `I couldn't schedule the event: ${msg}`,
      slots,
      toolResult: result,
    };
  }

  // 5. Extract verified info from the actual tool result. Composio's
  // CREATE_EVENT wraps the real Google Calendar payload under
  // `data.response_data` — htmlLink, hangoutLink, conferenceData all live
  // there. We probe both the wrapped path and a handful of fallbacks so
  // the handler keeps working if Composio reshapes the response.
  const raw = result?.data ?? result ?? {};
  const data = raw?.response_data ?? raw;
  const eventId =
    data?.id ?? data?.eventId ?? data?.event_id ?? data?.event?.id ?? undefined;
  const eventLink =
    data?.htmlLink ??
    data?.html_link ??
    data?.event_link ??
    data?.eventLink ??
    data?.url ??
    raw?.display_url ??
    data?.event?.htmlLink ??
    undefined;
  const meetLink =
    data?.hangoutLink ??
    data?.hangout_link ??
    data?.meet_link ??
    data?.meetLink ??
    data?.conferenceData?.entryPoints?.find(
      (e: any) => e?.entryPointType === "video" || e?.uri?.includes("meet.google.com"),
    )?.uri ??
    data?.conferenceData?.entryPoints?.[0]?.uri ??
    data?.event?.hangoutLink ??
    undefined;

  console.log(
    `[calendar] success — eventId=${eventId ?? "(none)"} eventLink=${eventLink ?? "(none)"} meetLink=${meetLink ?? "(none)"}`,
  );

  return {
    status: "success",
    slots,
    start,
    end,
    attendees: slots.attendeesEmails,
    toolResult: data,
    eventId,
    eventLink,
    meetLink,
  };
}

export function formatEventSuccess(
  outcome: Extract<CalendarOutcome, { status: "success" }>,
  tz: string,
): string {
  const startStr = outcome.start.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const endStr = outcome.end.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });
  const lines: string[] = [
    `Scheduled **${outcome.slots.title}** for ${startStr} – ${endStr}.`,
  ];
  if (outcome.attendees.length > 0) {
    lines.push(`Invited: ${outcome.attendees.join(", ")}`);
  }
  if (outcome.eventLink) {
    lines.push(`[Open in Calendar](${outcome.eventLink})`);
  }
  // Only mention Meet when the tool actually returned one. If the user
  // asked for Meet but the response didn't include a link, say so
  // honestly — don't fabricate.
  if (!outcome.meetLink && outcome.slots.wantsMeet) {
    lines.push(
      `_Note: I requested a Google Meet room but the Calendar response didn't include a Meet link in its payload. The event itself was created — open it in Calendar to confirm._`,
    );
  }
  if (outcome.meetLink) {
    lines.push(`[Google Meet](${outcome.meetLink})`);
  }
  return lines.join("\n\n");
}
