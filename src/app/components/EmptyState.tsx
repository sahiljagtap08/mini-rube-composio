type Props = { onPick: (prompt: string) => void };

const SUGGESTIONS: { label: string; prompt: string }[] = [
  {
    label: "📥 Summarize my last 100 emails",
    prompt: "Read my last 100 emails and show me the important ones",
  },
  {
    label: "📅 Schedule a meeting tomorrow",
    prompt: "Schedule a 30 minute calendar event tomorrow with Karan",
  },
  {
    label: "📎 Send an email with attachment",
    prompt: "Send an email with the attached PDF",
  },
  {
    label: "🐙 GitHub issues → Google Sheet",
    prompt:
      "Read all open and closed issues in composiohq/composio and make a Google Sheet of the problems",
  },
  {
    label: "📁 Resumes in Drive → Sheet",
    prompt:
      "Take all the resumes in this Drive folder and put candidates' name, university and last job into a Google Sheet",
  },
];

export function EmptyState({ onPick }: Props) {
  return (
    <div className="empty-state">
      <div className="empty-hero">
        <h1 className="empty-title">What can I help you do?</h1>
        <p className="empty-sub">
          A general agent for Gmail, Calendar, Drive, Sheets and GitHub.
        </p>
      </div>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.prompt}
            type="button"
            className="suggestion"
            onClick={() => onPick(s.prompt)}
          >
            <span className="suggestion-label">{s.label}</span>
            <span className="suggestion-prompt">{s.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
