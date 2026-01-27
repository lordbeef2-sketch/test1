import { useEffect, useMemo, useState } from 'react';
import { api, AccessDeniedError } from './api/client';
import type { GroupMember, SessionInfo, StatusRow } from './api/types';
import { AliveBadge } from './components/AliveBadge';
import { CheckoutPicker } from './components/CheckoutPicker';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'denied' }
  | { kind: 'ready'; session: SessionInfo };

export function App() {
  const [view, setView] = useState<ViewState>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    api
      .session()
      .then((s) => {
        if (!alive) return;
        setView({ kind: 'ready', session: s });
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof AccessDeniedError) setView({ kind: 'denied' });
        else setView({ kind: 'denied' });
      });

    return () => {
      alive = false;
    };
  }, []);

  if (view.kind === 'loading') return <div className="denied">Access Denied</div>;
  if (view.kind === 'denied') return <div className="denied">Access Denied</div>;

  return <Dashboard session={view.session} />;
}

function Dashboard({ session }: { session: SessionInfo }) {
  const [rows, setRows] = useState<StatusRow[]>([]);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [filter, setFilter] = useState('');
  const [toast, setToast] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = async () => {
    const [s, m] = await Promise.all([api.status(), api.groupMembers()]);
    setRows(s);
    setMembers(m);
  };

  useEffect(() => {
    load().catch(() => {
      // If something fails for an authorized user, keep UI minimal.
      setToast('Refresh failed');
      setTimeout(() => setToast(''), 2500);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      load().catch(() => {
        setToast('Refresh failed');
        setTimeout(() => setToast(''), 2500);
      });
    }, session.refreshSeconds * 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.refreshSeconds]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.computerName.toLowerCase().includes(q) ||
        r.ipAddress.toLowerCase().includes(q) ||
        r.loggedInUser.toLowerCase().includes(q) ||
        r.checkoutUser.toLowerCase().includes(q)
    );
  }, [rows, filter]);

  const onSave = async (computerName: string, checkoutUser: string) => {
    setBusyKey(computerName);
    try {
      await api.checkout(computerName, checkoutUser);
      setToast('Saved');
      await load();
    } catch (e) {
      setToast(String((e as any)?.message || 'Save failed'));
    } finally {
      setBusyKey(null);
      setTimeout(() => setToast(''), 2500);
    }
  };

  return (
    <div className="container">
      <div className="card">
        <div className="header">
          <h1 className="h1">DLT Dashboard</h1>
          <div className="muted">Signed in: {session.user}</div>
        </div>

        <div className="controls">
          <input
            className="input"
            placeholder="Search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="button" onClick={() => load()}>
            Refresh
          </button>
          <button className="button" onClick={() => api.logout().then(() => location.reload())}>
            Sign out
          </button>
          <div className="muted">Auto refresh: {session.refreshSeconds}s</div>
        </div>

        <div style={{ height: 14 }} />

        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Computer Name</th>
                <th>IP Address</th>
                <th>Alive</th>
                <th>Logged-in User</th>
                <th>Checkout</th>
                <th>Audit</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.computerName}>
                  <td>{r.computerName}</td>
                  <td className="small">{r.ipAddress}</td>
                  <td>
                    <AliveBadge alive={r.alive} title={r.errorMessage || ''} />
                  </td>
                  <td className="small" title={r.errorMessage || ''}>
                    {r.loggedInUser}
                  </td>
                  <td>
                    <div className="rowActions">
                      <CheckoutPicker
                        members={members}
                        value={r.checkoutUser}
                        onChange={(v) => onSave(r.computerName, v)}
                        disabled={busyKey === r.computerName}
                      />
                    </div>
                  </td>
                  <td className="small">
                    {r.checkoutUser ? (
                      <>
                        <div>{r.lastUpdatedBy}</div>
                        <div>{r.checkoutAgeDays ?? 0}d</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    </div>
  );
}
