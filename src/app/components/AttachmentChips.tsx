import { XIcon } from "./icons";
import { formatBytes } from "../utils/toolLabels";

export type Attachment = {
  id: string;
  filename: string;
  mime: string;
  size: number;
};

type Props = {
  attachments: Attachment[];
  onRemove: (id: string) => void;
};

export function AttachmentChips({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-row">
      {attachments.map((a) => (
        <span key={a.id} className="attachment-chip" title={a.mime}>
          <span className="attachment-chip-name">{a.filename}</span>
          <span className="attachment-chip-size">{formatBytes(a.size)}</span>
          <button
            type="button"
            className="attachment-chip-remove"
            onClick={() => onRemove(a.id)}
            aria-label={`Remove ${a.filename}`}
          >
            <XIcon />
          </button>
        </span>
      ))}
    </div>
  );
}
