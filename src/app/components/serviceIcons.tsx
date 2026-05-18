// Brand-recognizable icons rendered as inline SVGs (no remote images, no icon
// libraries). 18×18 default; multi-color where the real product mark is.
// Shapes are simplified for legibility at small sizes but kept close enough
// to the real logo silhouettes to be instantly recognizable.

const SIZE = 18;

export function GmailIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#EA4335" d="M2 6.5C2 5.67 2.67 5 3.5 5h.5l8 6 8-6h.5c.83 0 1.5.67 1.5 1.5V18a2 2 0 0 1-2 2h-3V11l-5 3.75L7 11v9H4a2 2 0 0 1-2-2V6.5z" />
      <path fill="#FBBC04" d="M2 6.5V18a2 2 0 0 0 2 2h3V11L2 6.5z" />
      <path fill="#34A853" d="M22 6.5V18a2 2 0 0 1-2 2h-3V11l5-4.5z" />
      <path fill="#C5221F" d="M12 11 4 5h16l-8 6z" />
      <path fill="#fff" opacity=".2" d="m7 11 5 3.75L17 11v.5L12 15 7 11.5z" />
    </svg>
  );
}

export function CalendarIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="17" rx="2" fill="#fff" stroke="#1A73E8" strokeWidth="1.6" />
      <path fill="#1A73E8" d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3H3V6z" />
      <rect x="6.5" y="2.5" width="1.8" height="4" rx="0.6" fill="#1A73E8" />
      <rect x="15.7" y="2.5" width="1.8" height="4" rx="0.6" fill="#1A73E8" />
      <circle cx="8" cy="13.5" r="1" fill="#1A73E8" />
      <circle cx="12" cy="13.5" r="1" fill="#1A73E8" />
      <circle cx="16" cy="13.5" r="1" fill="#1A73E8" />
      <circle cx="8" cy="17" r="1" fill="#1A73E8" />
      <circle cx="12" cy="17" r="1" fill="#1A73E8" />
    </svg>
  );
}

export function DriveIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0066DA" d="M2.6 18.4 4.1 21c.3.5.7.9 1.2 1.2L9.9 14H2.5c0 .5.1 1 .4 1.4l-.3 3z" transform="translate(0,-2)" />
      <path fill="#00AC47" d="m12 7.4-3.7-6.4c-.5.3-.9.7-1.2 1.2L1 13c-.3.4-.4 1-.4 1.4h7.5L12 7.4z" />
      <path fill="#EA4335" d="M20.2 22c.5-.3.9-.7 1.2-1.2l.9-1.6 3.1-5.2c.3-.4.4-1 .4-1.4h-7.5l1.6 3.2 0 6.2z" transform="translate(-4,-3)" />
      <path fill="#FFBA00" d="m20.4 8.4-3.6-6.2c-.3-.4-.7-.7-1.2-.9L12 7.4l4.5 7.8H24c0-.5-.1-1-.4-1.4l-3.2-5.4z" transform="translate(-1.5,-0.5)" />
      <path fill="#2684FC" d="M16.5 15.2H7.6L4 21.4c.4.2.9.3 1.4.3h13.1c.5 0 1-.1 1.4-.3l-3.4-6.2z" />
      <path fill="#00832D" d="m12 7.4 3.6-6.2C15.2 1 14.7.9 14.2.9H9.8c-.5 0-1 .1-1.4.3L12 7.4z" />
    </svg>
  );
}

export function SheetsIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#0F9D58" d="M14.5 2H5.5A1.5 1.5 0 0 0 4 3.5v17A1.5 1.5 0 0 0 5.5 22h13a1.5 1.5 0 0 0 1.5-1.5V7.5L14.5 2z" />
      <path fill="#87CEAC" d="M14.5 2v4A1.5 1.5 0 0 0 16 7.5h4L14.5 2z" />
      <path fill="#F1F8E9" d="M8 11h8v8H8z" />
      <path fill="#0F9D58" d="M11 11h1v8h-1zM8 13.7h8v.6H8zM8 16.4h8v.6H8z" />
    </svg>
  );
}

export function DocsIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M14.5 2H5.5A1.5 1.5 0 0 0 4 3.5v17A1.5 1.5 0 0 0 5.5 22h13a1.5 1.5 0 0 0 1.5-1.5V7.5L14.5 2z" />
      <path fill="#A1C2FA" d="M14.5 2v4A1.5 1.5 0 0 0 16 7.5h4L14.5 2z" />
      <path fill="#fff" d="M8 11h8v1H8zm0 2.5h8v1H8zm0 2.5h8v1H8zm0 2.5h6v1H8z" />
    </svg>
  );
}

export function ContactsIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="4" width="19" height="16" rx="2" fill="#1A73E8" />
      <rect x="2.5" y="4" width="19" height="4" rx="2" fill="#0B57D0" />
      <circle cx="12" cy="13" r="2.6" fill="#fff" />
      <path fill="#fff" d="M7 19c1-2.6 2.8-3.5 5-3.5s4 .9 5 3.5z" />
    </svg>
  );
}

export function GitHubIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="#181717" aria-hidden="true">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.3 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
    </svg>
  );
}

export function GenericToolIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="#71717a" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4L15.5 5z" />
    </svg>
  );
}

export function SparklesIcon() {
  return (
    <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="#7c3aed" aria-hidden="true">
      <path d="M9 3l1.4 3.6L14 8l-3.6 1.4L9 13 7.6 9.4 4 8l3.6-1.4z" />
      <path d="M17 13l.9 2.2L20 16l-2.1.9L17 19l-.9-2.1L14 16l2.1-.8z" />
    </svg>
  );
}
