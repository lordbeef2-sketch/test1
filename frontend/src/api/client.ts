import type { GroupMember, SessionInfo, StatusRow } from './types';

export class AccessDeniedError extends Error {
  constructor() {
    super('Access Denied');
  }
}

function getCookie(name: string): string {
  const parts = document.cookie.split(';').map((c) => c.trim());
  const found = parts.find((p) => p.startsWith(name + '='));
  if (!found) return '';
  return decodeURIComponent(found.substring(name.length + 1));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(init?.method && init.method.toUpperCase() !== 'GET'
        ? { 'X-CSRF-Token': getCookie('XSRF-TOKEN') }
        : {}),
    },
  });

  if (res.status === 403 || res.status === 401) {
    const text = await res.text();
    if (text === 'Access Denied') throw new AccessDeniedError();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }

  return (await res.json()) as T;
}

export const api = {
  session: () => fetchJson<SessionInfo>('/api/session'),
  status: () => fetchJson<StatusRow[]>('/api/status'),
  groupMembers: () => fetchJson<GroupMember[]>('/api/groupMembers'),
  checkout: (computerName: string, checkoutUser: string) =>
    fetchJson<{ computerName: string; checkoutUser: string; lastUpdatedBy: string; lastUpdatedAt: string }>(
      '/api/checkout',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ computerName, checkoutUser }),
      }
    ),
  logout: () => fetchJson<{ ok: true }>('/api/logout', { method: 'POST' }),
};
