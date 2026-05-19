import { useEffect, useRef, useState } from "react";
import { GitHubIcon, GoogleGIcon } from "./serviceIcons";

export type Toolkit = "googlesuper" | "github";

const LABEL: Record<Toolkit, string> = {
  googlesuper: "Google",
  github: "GitHub",
};

function ToolkitIcon({ toolkit }: { toolkit: Toolkit }) {
  if (toolkit === "googlesuper") return <GoogleGIcon size={14} />;
  return <GitHubIcon size={14} />;
}

type Props = {
  connections: Record<string, boolean>;
  pending: Record<string, boolean>;
  onConnect: (toolkit: Toolkit) => void;
  onDisconnect: (toolkit: Toolkit) => void;
};

export function ConnectionChips({
  connections,
  pending,
  onConnect,
  onDisconnect,
}: Props) {
  const toolkits: Toolkit[] = ["googlesuper", "github"];
  const [openMenu, setOpenMenu] = useState<Toolkit | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // close menu on outside click
  useEffect(() => {
    if (!openMenu) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpenMenu(null);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [openMenu]);

  return (
    <div className="conn-chips" role="group" aria-label="Connections" ref={wrapRef}>
      {toolkits.map((tk) => {
        const isConnected = !!connections[tk];
        const isPending = !!pending[tk];
        const menuOpen = openMenu === tk;
        return (
          <div key={tk} className="conn-chip-wrap">
            <button
              type="button"
              className={`conn-chip ${isConnected ? "is-connected" : ""} ${isPending ? "is-pending" : ""}`}
              onClick={() => {
                if (isPending) return;
                if (isConnected) setOpenMenu(menuOpen ? null : tk);
                else onConnect(tk);
              }}
              disabled={isPending}
              title={
                isConnected
                  ? `${LABEL[tk]} is connected — click for options`
                  : `Connect ${LABEL[tk]}`
              }
              aria-haspopup={isConnected ? "menu" : undefined}
              aria-expanded={isConnected ? menuOpen : undefined}
            >
              <span className="conn-chip-icon">
                <ToolkitIcon toolkit={tk} />
              </span>
              <span>
                {isPending
                  ? `Connecting ${LABEL[tk]}…`
                  : isConnected
                    ? `${LABEL[tk]} connected`
                    : `Connect ${LABEL[tk]}`}
              </span>
              {isConnected && <span className="conn-dot" aria-hidden="true" />}
            </button>
            {menuOpen && (
              <div className="conn-menu" role="menu">
                <button
                  type="button"
                  className="conn-menu-item"
                  onClick={() => {
                    setOpenMenu(null);
                    onConnect(tk);
                  }}
                >
                  Reconnect
                </button>
                <button
                  type="button"
                  className="conn-menu-item conn-menu-danger"
                  onClick={() => {
                    setOpenMenu(null);
                    if (confirm(`Disconnect ${LABEL[tk]}? You'll need to reauthorize to use it again.`)) {
                      onDisconnect(tk);
                    }
                  }}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
