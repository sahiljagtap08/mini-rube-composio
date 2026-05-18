export type Toolkit = "googlesuper" | "github";

const LABEL: Record<Toolkit, string> = {
  googlesuper: "Google",
  github: "GitHub",
};

type Props = {
  connections: Record<string, boolean>;
  pending: Record<string, boolean>;
  onConnect: (toolkit: Toolkit) => void;
};

export function ConnectionChips({ connections, pending, onConnect }: Props) {
  const toolkits: Toolkit[] = ["googlesuper", "github"];
  return (
    <div className="conn-chips" role="group" aria-label="Connections">
      {toolkits.map((tk) => {
        const isConnected = !!connections[tk];
        const isPending = !!pending[tk];
        return (
          <button
            key={tk}
            type="button"
            className={`conn-chip ${isConnected ? "is-connected" : ""} ${isPending ? "is-pending" : ""}`}
            onClick={() => !isConnected && !isPending && onConnect(tk)}
            disabled={isPending}
            title={isConnected ? `${LABEL[tk]} is connected` : `Connect ${LABEL[tk]}`}
          >
            <span className="conn-dot" aria-hidden="true" />
            <span>
              {isPending
                ? `Connecting ${LABEL[tk]}…`
                : isConnected
                  ? `${LABEL[tk]} connected`
                  : `Connect ${LABEL[tk]}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
