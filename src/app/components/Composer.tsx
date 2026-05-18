import { useRef, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUpIcon, PaperclipIcon, Spinner } from "./icons";
import { AttachmentChips, type Attachment } from "./AttachmentChips";

type Props = {
  value: string;
  // useChat's handleInputChange is typed for HTMLInputElement but the SDK
  // accepts either; we keep the type permissive and cast at the call site.
  onChange: (e: any) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  attachments: Attachment[];
  uploading: boolean;
  onUploadFile: (file: File) => void;
  onRemoveAttachment: (id: string) => void;
  isLoading: boolean;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  attachments,
  uploading,
  onUploadFile,
  onRemoveAttachment,
  isLoading,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <div className="composer-wrap">
      <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />
      <form ref={formRef} className="composer" onSubmit={onSubmit}>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadFile(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="composer-attach"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || isLoading}
          title="Attach a file"
          aria-label="Attach a file"
        >
          {uploading ? <Spinner /> : <PaperclipIcon />}
        </button>
        <textarea
          className="composer-input"
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="Ask anything…"
          rows={1}
          disabled={isLoading}
          aria-label="Message"
        />
        <button
          type="submit"
          className="composer-send"
          disabled={isLoading || (!value.trim() && attachments.length === 0)}
          title="Send"
          aria-label="Send message"
        >
          {isLoading ? <Spinner /> : <ArrowUpIcon />}
        </button>
      </form>
      <div className="composer-hint">
        Enter to send · Shift+Enter for newline
      </div>
    </div>
  );
}
