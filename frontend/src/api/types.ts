export type AliveState = true | false | 'unknown';

export type StatusRow = {
  computerName: string;
  ipAddress: string;
  alive: AliveState;
  errorMessage: string;
  loggedInUser: string;
  checkoutUser: string;
  checkoutAgeDays: number | null;
  lastUpdatedBy: string | null;
  lastUpdatedAt: string | null;
};

export type GroupMember = { user: string; displayName: string };

export type SessionInfo = { user: string; refreshSeconds: number };
