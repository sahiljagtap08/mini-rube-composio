import { ConnectionChips, type Toolkit } from "./ConnectionChips";

type Props = {
  connections: Record<string, boolean>;
  pending: Record<string, boolean>;
  onConnect: (tk: Toolkit) => void;
};

export function Header({ connections, pending, onConnect }: Props) {
  return (
    <header className="app-header">
      <div className="app-brand">
        <span className="app-brand-mark" aria-hidden="true">◐</span>
        <span className="app-brand-name">mini-rube</span>
      </div>
      <ConnectionChips
        connections={connections}
        pending={pending}
        onConnect={onConnect}
      />
    </header>
  );
}
