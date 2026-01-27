import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pLimit from 'p-limit';
import type { AppConfig } from './config';

const execFileAsync = promisify(execFile);

export type AliveState = true | false | 'unknown';

export type ComputerStatus = {
  computerName: string;
  ipAddress: string;
  alive: AliveState;
  errorMessage: string;
  loggedInUser: string;
  loggedInUserError: string;
};

export async function pollAllComputers(config: AppConfig): Promise<ComputerStatus[]> {
  const limit = pLimit(config.concurrencyLimit);
  const tasks = config.computers.map((c) =>
    limit(() => pollOneComputer(c.computerName, config))
  );
  return Promise.all(tasks);
}

async function pollOneComputer(computerName: string, config: AppConfig): Promise<ComputerStatus> {
  const ip = await resolveIp(computerName);
  const { alive, errorMessage } = await checkAlive(ip.ipAddress !== 'Unknown' ? ip.ipAddress : computerName, config);
  const logged = await getLoggedInUser(computerName);

  return {
    computerName,
    ipAddress: ip.ipAddress,
    alive,
    errorMessage: errorMessage || ip.errorMessage,
    loggedInUser: logged.user,
    loggedInUserError: logged.errorMessage,
  };
}

async function resolveIp(host: string): Promise<{ ipAddress: string; errorMessage: string }>
{
  try {
    const res = await dns.lookup(host, { family: 4 });
    return { ipAddress: res.address, errorMessage: '' };
  } catch (e) {
    return { ipAddress: 'Unknown', errorMessage: `DNS: ${safeErr(e)}` };
  }
}

async function checkAlive(target: string, config: AppConfig): Promise<{ alive: AliveState; errorMessage: string }>
{
  const ping = await icmpPing(target, config.pingTimeoutMs);
  if (ping.alive !== 'unknown') {
    return ping;
  }
  const tcp = await tcpProbe(target, config.tcpProbePort, config.pingTimeoutMs);
  return tcp;
}

async function icmpPing(target: string, timeoutMs: number): Promise<{ alive: AliveState; errorMessage: string }>
{
  // Windows ping: -n 1 one echo, -w timeout in ms.
  try {
    const { stdout } = await execFileAsync('ping', ['-n', '1', '-w', String(timeoutMs), target], {
      timeout: timeoutMs + 500,
      windowsHide: true,
    });

    const out = String(stdout || '');
    if (/TTL=\d+/i.test(out) || /Reply from/i.test(out)) {
      return { alive: true, errorMessage: '' };
    }
    if (/Destination host unreachable|Request timed out/i.test(out)) {
      return { alive: false, errorMessage: 'ICMP: no reply' };
    }
    return { alive: 'unknown', errorMessage: 'ICMP: unknown result' };
  } catch (e) {
    return { alive: 'unknown', errorMessage: `ICMP: ${safeErr(e)}` };
  }
}

function tcpProbe(target: string, port: number, timeoutMs: number): Promise<{ alive: AliveState; errorMessage: string }>
{
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (alive: AliveState, msg: string) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve({ alive, errorMessage: msg });
    };

    socket.setTimeout(timeoutMs);

    socket.once('connect', () => finish(true, ''));
    socket.once('timeout', () => finish(false, `TCP: timeout:${port}`));
    socket.once('error', (err) => finish(false, `TCP: ${safeErr(err)}`));

    socket.connect(port, target);
  });
}

async function getLoggedInUser(computerName: string): Promise<{ user: string; errorMessage: string }>
{
  // Primary: CIM/WMI query
  const cim = await queryCimUserName(computerName);
  if (cim.user !== 'Unknown') return cim;

  // Fallback: quser
  const q = await queryQuser(computerName);
  return q;
}

async function queryCimUserName(computerName: string): Promise<{ user: string; errorMessage: string }>
{
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; (Get-CimInstance -ClassName Win32_ComputerSystem -ComputerName '" + computerName.replace(/'/g, "''") + "' -OperationTimeoutSec 3).UserName",
      ],
      { timeout: 3500, windowsHide: true }
    );

    const user = String(stdout || '').trim();
    if (!user) return { user: 'Unknown', errorMessage: 'WMI: empty' };
    return { user, errorMessage: '' };
  } catch (e) {
    return { user: 'Unknown', errorMessage: `WMI: ${safeErr(e)}` };
  }
}

async function queryQuser(computerName: string): Promise<{ user: string; errorMessage: string }>
{
  try {
    const { stdout } = await execFileAsync('quser', ['/server:' + computerName], {
      timeout: 3500,
      windowsHide: true,
    });

    const lines = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim());

    if (lines.length < 2) return { user: 'Unknown', errorMessage: 'quser: no sessions' };

    // Skip header; attempt to find an active line.
    const candidates = lines.slice(1);
    const active = candidates.find((l) => /\sActive\s/i.test(l)) || candidates[0];
    const username = active.trim().split(/\s+/)[0]?.replace(/^>/, '') || '';
    if (!username) return { user: 'Unknown', errorMessage: 'quser: parse' };
    return { user: username, errorMessage: '' };
  } catch (e) {
    return { user: 'Unknown', errorMessage: `quser: ${safeErr(e)}` };
  }
}

function safeErr(e: unknown): string {
  if (!e) return 'unknown';
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && 'message' in e && typeof (e as any).message === 'string') return (e as any).message;
  return 'unknown';
}
