import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type DomainContext = { detectedDomain: string; detectedForest?: string };

function normalizeDomainName(domain: string): string {
  return domain.trim();
}

export async function detectDomainContext(): Promise<DomainContext> {
  // Best-effort detection on Windows; returns empty strings if unavailable.
  const envDomain = process.env.USERDNSDOMAIN || process.env.USERDOMAIN || '';
  if (envDomain && envDomain.trim()) {
    return { detectedDomain: normalizeDomainName(envDomain) };
  }

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop'; (Get-CimInstance Win32_ComputerSystem).Domain",
      ],
      { timeout: 3000, windowsHide: true }
    );

    const detectedDomain = normalizeDomainName(String(stdout || ''));
    return { detectedDomain };
  } catch {
    return { detectedDomain: '' };
  }
}
