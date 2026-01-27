import type { AliveState } from '../api/types';

export function AliveBadge({ alive, title }: { alive: AliveState; title?: string }) {
  const cls = alive === true ? 'ok' : alive === false ? 'bad' : 'unk';
  const label = alive === true ? 'Alive' : alive === false ? 'Down' : 'Unknown';

  return (
    <span className={`badge ${cls}`} title={title || ''}>
      <span className="dot" />
      {label}
    </span>
  );
}
