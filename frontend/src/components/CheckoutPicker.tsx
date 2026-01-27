import { useMemo, useState } from 'react';
import type { GroupMember } from '../api/types';

export function CheckoutPicker(props: {
  members: GroupMember[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { members, value, onChange, disabled } = props;
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return members;
    return members.filter(
      (m) => m.user.toLowerCase().includes(qq) || m.displayName.toLowerCase().includes(qq)
    );
  }, [members, q]);

  return (
    <div>
      <input
        className="input"
        placeholder="Search group members"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        disabled={disabled}
      />
      <div style={{ height: 8 }} />
      <select
        className="select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">(Clear)</option>
        {filtered.map((m) => (
          <option key={m.user} value={m.user}>
            {m.user} — {m.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}
