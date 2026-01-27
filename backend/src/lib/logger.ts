export type AuditEvent =
  | { kind: 'auth_success'; user: string }
  | { kind: 'auth_denied'; user?: string }
  | { kind: 'checkout_write'; user: string; computerName: string; checkoutUser: string };

export function auditLog(evt: AuditEvent): void {
  const ts = new Date().toISOString();
  const base = { ts, kind: evt.kind };
  // Never log secrets (passwords, bind creds). Only log usernames and targets.
  // Keep logs parseable and concise.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...base, ...evt }));
}
