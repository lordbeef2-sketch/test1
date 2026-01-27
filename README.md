# DLT (Domain-Limited Tracker)

By Ray Reeves

Production-ready intranet dashboard for workstation availability + checkout tracking.

Security model (non-negotiable): the primary gate is **Active Directory group membership**.

- Anyone not in the configured allowed AD group receives **only** the exact body: `Access Denied`.
- The backend enforces this on **every route** (/, static assets, and all /api/*).
- The frontend bundle is not served at all to denied users.

## Folder structure

- backend/ — Node.js (LTS) + Express + TypeScript backend (listens on **9191**)
- frontend/ — React + TypeScript (Vite) frontend
- config.json — runtime configuration (inventory + polling knobs + allowed group)
- data/ — SQLite database file(s)

## Prerequisites (Windows Server)

- Windows Server joined to the domain.
- Node.js LTS (recommended Node 20+).
## Zero-password goal (no typed credentials)

This app supports a **no-username/no-password** operational model:


Recommended: run the backend as a **domain identity** (ideally a **gMSA**) with read access to AD and with permissions to query workstation WMI/quser.

### Running as a domain user (your chosen model)

- Run `npm run -w backend start` from a console logged in as the domain user, or run the backend as a Windows Service under that domain user.
- That domain user must be able to:
  - read Active Directory (typically allowed)
  - query remote WMI / `quser` on the workstation fleet (grant via GPO/Local Security Policy)

Quick AD connectivity self-test (run as the same domain user):

```powershell
powershell.exe -NoProfile -NonInteractive -Command "$root=New-Object System.DirectoryServices.DirectoryEntry('LDAP://RootDSE'); $root.Properties['defaultNamingContext'][0]"
```

If this prints nothing or errors, the server is not domain-joined or cannot reach a DC.

## Required environment variables (backend)

Set these before running the backend:

- `DLT_SESSION_SECRET` — long random string for session signing.

Optional:

- `DLT_CONFIG_PATH` — path to config.json (default: `../config.json` from backend)
- `DLT_DB_PATH` — checkout SQLite path (default: `../data/dlt.sqlite`)
- `DLT_SESSION_DB_PATH` — session SQLite path (default: `./data/sessions.sqlite`)
- `DLT_LISTEN_HOST` — default `0.0.0.0`

## Build & run

### 1) Install dependencies

From the repo root:

```powershell
cd C:\sand\DLT
npm install
```

### 2) Build frontend

```powershell
npm run -w frontend build
```

### 3) Build & run backend

```powershell
npm run -w backend build
npm run -w backend start
```

Then browse: `http://<server>:9191/`

### Bind address (localhost by default)

By default the backend listens on `127.0.0.1:9191` (localhost only).

To expose it on the network explicitly:

```powershell
$env:DLT_LISTEN_HOST='0.0.0.0'
npm run -w backend start
```

## Windows SSO notes (node-expose-sspi)

- In many environments this will negotiate **Kerberos** when properly configured; otherwise it may fall back to **NTLM**.
- For Kerberos in production you typically need an SPN registered for the service account running the Node process (or for the reverse-proxy identity if terminating there).
- Ensure the site is treated as an intranet site by clients so browsers will send default credentials.

If you front this with HTTPS (recommended), set:

- `DLT_COOKIE_SECURE=true` so the `XSRF-TOKEN` cookie is marked Secure.

## AD query notes (no passwords)

Group membership checks, group member enumeration, and checkout user validation are performed using **integrated Windows auth** by executing PowerShell that uses .NET `System.DirectoryServices.DirectorySearcher`.

That means:

- The server must be domain-joined.
- The Windows account running the backend must have directory read permissions (usually true for domain accounts).
- If the backend runs as LocalSystem, AD access may be limited depending on your domain policies.

## First run behavior (domain detection)

On startup, if `detectedDomain` in config.json is empty, the backend attempts to detect the server’s AD domain context and writes it back to config.json using an atomic write.

## Monitoring permissions & hardening notes

### Remote logged-in user detection

The backend tries (in order):

1. WMI/CIM: `Win32_ComputerSystem.UserName` via PowerShell `Get-CimInstance`
2. `quser /server:<computer>`

These typically require:

- A domain service account running the backend with permissions to query WMI on target machines.
- Firewall rules allowing WMI/RPC (or WinRM if you later switch the implementation).

Recommended service account model:

- Run backend service as a dedicated domain account (least privilege), granted:
  - read-only LDAP
  - WMI remote query rights (via local group or GPO on workstations)

### Security hardening

- Prefer HTTPS in front of the node process (IIS reverse proxy or load balancer) for Kerberos and to protect session cookies.
- Restrict inbound access to port 9191 to trusted subnets.
- Ensure the allowed AD group is a **security** group.

