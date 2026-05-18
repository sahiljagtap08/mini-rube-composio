import { AlertIcon, XIcon } from "./icons";

export type AppErrorKind = "connection" | "provider" | "tool" | "upload" | "general";

export type AppError = {
  id: string;
  kind: AppErrorKind;
  title?: string;
  message: string;
};

const DEFAULT_TITLE: Record<AppErrorKind, string> = {
  connection: "Connection issue",
  provider: "Model provider error",
  tool: "Tool failed",
  upload: "Upload failed",
  general: "Something went wrong",
};

type Props = {
  error: AppError;
  onDismiss?: (id: string) => void;
};

export function ErrorCard({ error, onDismiss }: Props) {
  return (
    <div className={`error-card error-card-${error.kind}`} role="alert">
      <span className="error-card-icon">
        <AlertIcon />
      </span>
      <div className="error-card-body">
        <div className="error-card-title">{error.title ?? DEFAULT_TITLE[error.kind]}</div>
        <div className="error-card-message">{error.message}</div>
      </div>
      {onDismiss && (
        <button
          type="button"
          className="error-card-dismiss"
          onClick={() => onDismiss(error.id)}
          aria-label="Dismiss error"
        >
          <XIcon />
        </button>
      )}
    </div>
  );
}

export function ErrorStack({
  errors,
  onDismiss,
}: {
  errors: AppError[];
  onDismiss: (id: string) => void;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="error-stack">
      {errors.map((e) => (
        <ErrorCard key={e.id} error={e} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
