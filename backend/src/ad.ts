import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GroupMember = { user: string; displayName: string };

function parseAllowedGroup(allowedAdGroup: string): { domain: string | null; groupNameOrSid: string } {
  const v = allowedAdGroup.trim();
  if (/^S-1-\d+(-\d+)+$/i.test(v)) {
    return { domain: null, groupNameOrSid: v };
  }
  const m = /^([^\\]+)\\(.+)$/.exec(v);
  if (!m) return { domain: null, groupNameOrSid: v };
  return { domain: m[1] || null, groupNameOrSid: m[2] };
}

function escapeLdapFilter(v: string): string {
  // RFC 4515 escaping
  return v
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00');
}

function psQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function runPsJson<T>(script: string, timeoutMs: number): Promise<T> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 50 * 1024 * 1024 }
    );
    const out = String(stdout || '').trim();
    if (!out) throw new Error('AD query returned no output');
    return JSON.parse(out) as T;
  } catch (e: any) {
    const msg = typeof e?.message === 'string' ? e.message : 'AD query failed';
    throw new Error(msg);
  }
}

export async function resolveAllowedGroupDN(
  allowedAdGroup: string
): Promise<{ groupDN: string; groupDomainLabel: string | null }> {
  const { domain, groupNameOrSid } = parseAllowedGroup(allowedAdGroup);

  const isSid = /^S-1-/.test(groupNameOrSid);
  const filterForName = `(&(objectClass=group)(|(sAMAccountName=${escapeLdapFilter(groupNameOrSid)})(cn=${escapeLdapFilter(groupNameOrSid)})))`;

  const script = `
$ErrorActionPreference='Stop'
$root = New-Object System.DirectoryServices.DirectoryEntry('LDAP://RootDSE')
$base = [string]($root.Properties['defaultNamingContext'][0])
$ifMissing = [string]::IsNullOrWhiteSpace($base)
if ($ifMissing) { throw 'Active Directory not available (domain not joined or DC unreachable)' }

function SidToLdapBytes([string]$sidString) {
  $sid = New-Object System.Security.Principal.SecurityIdentifier($sidString)
  $bytes = New-Object byte[] ($sid.BinaryLength)
  $sid.GetBinaryForm($bytes, 0)
  ($bytes | ForEach-Object { '\\' + $_.ToString('X2') }) -join ''
}

$searchRoot = New-Object System.DirectoryServices.DirectoryEntry(("LDAP://" + $base))
$searcher=New-Object System.DirectoryServices.DirectorySearcher($searchRoot)
$searcher.PageSize=200
$searcher.SizeLimit=2
if (${isSid ? '$true' : '$false'}) {
  $sidBytes = SidToLdapBytes(${psQuote(groupNameOrSid)})
  $searcher.Filter = "(&(objectClass=group)(objectSid=$sidBytes))"
} else {
  $searcher.Filter=${psQuote(filterForName)}
}
$null=$searcher.PropertiesToLoad.Add('distinguishedName')
$res=$searcher.FindAll()
if ($res.Count -ne 1) { throw 'Allowed AD group not found or not unique' }
$dn=$res[0].Properties['distinguishedname'][0]
[pscustomobject]@{groupDN=$dn} | ConvertTo-Json -Compress
`.trim();

  const r = await runPsJson<{ groupDN: string }>(script, 8000);
  if (!r.groupDN) throw new Error('Allowed AD group DN missing');
  return { groupDN: r.groupDN, groupDomainLabel: domain };
}

export async function listAllowedGroupMembers(groupDN: string, domainLabel: string | null): Promise<GroupMember[]> {
  const filter = `(&(objectCategory=person)(objectClass=user)(memberOf:1.2.840.113556.1.4.1941:=${escapeLdapFilter(groupDN)}))`;

  const script = `
$ErrorActionPreference='Stop'
$root = New-Object System.DirectoryServices.DirectoryEntry('LDAP://RootDSE')
$base = [string]($root.Properties['defaultNamingContext'][0])
if ([string]::IsNullOrWhiteSpace($base)) { throw 'Active Directory not available (domain not joined or DC unreachable)' }
$searchRoot = New-Object System.DirectoryServices.DirectoryEntry(("LDAP://" + $base))
$searcher=New-Object System.DirectoryServices.DirectorySearcher($searchRoot)
$searcher.PageSize=500
$searcher.Filter=${psQuote(filter)}
$null=$searcher.PropertiesToLoad.Add('sAMAccountName')
$null=$searcher.PropertiesToLoad.Add('userPrincipalName')
$null=$searcher.PropertiesToLoad.Add('displayName')
$res=$searcher.FindAll()
$out=@()
foreach($r in $res){
  $sam=($r.Properties['samaccountname'] | Select-Object -First 1)
  $upn=($r.Properties['userprincipalname'] | Select-Object -First 1)
  $dnm=($r.Properties['displayname'] | Select-Object -First 1)
  if (-not $dnm) { $dnm = $sam }
  if (-not $dnm) { $dnm = $upn }
  $out += [pscustomobject]@{ sam=$sam; upn=$upn; displayName=$dnm }
}
$out | ConvertTo-Json -Compress
`.trim();

  const parsed = await runPsJson<any>(script, 20_000);
  const raw: Array<{ sam?: string; upn?: string; displayName?: string }> =
    parsed == null ? [] : Array.isArray(parsed) ? parsed : [parsed];
  const members: GroupMember[] = [];
  for (const e of raw) {
    const sam = (e.sam || '').trim();
    const upn = (e.upn || '').trim();
    const displayName = (e.displayName || sam || upn).trim();
    const user = normalizeUserLabel(domainLabel, sam, upn);
    if (user) members.push({ user, displayName });
  }
  members.sort((a, b) => a.user.localeCompare(b.user));
  return members;
}

export async function resolveAndValidateCheckoutUser(
  input: string,
  groupDN: string,
  domainLabel: string | null
): Promise<{ normalized: string } | null> {
  const v = input.trim();
  if (!v) return { normalized: '' };

  if (v.length > 256) return null;
  if (!/^[A-Za-z0-9@._\\-]+$/.test(v)) return null;

  const rawUser = stripDomainPrefix(v);

  const filter = `(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=${escapeLdapFilter(rawUser)})(userPrincipalName=${escapeLdapFilter(rawUser)}))(memberOf:1.2.840.113556.1.4.1941:=${escapeLdapFilter(groupDN)}))`;

  const script = `
$ErrorActionPreference='Stop'
$root = New-Object System.DirectoryServices.DirectoryEntry('LDAP://RootDSE')
$base = [string]($root.Properties['defaultNamingContext'][0])
if ([string]::IsNullOrWhiteSpace($base)) { throw 'Active Directory not available (domain not joined or DC unreachable)' }
$searchRoot = New-Object System.DirectoryServices.DirectoryEntry(("LDAP://" + $base))
$searcher=New-Object System.DirectoryServices.DirectorySearcher($searchRoot)
$searcher.PageSize=200
$searcher.SizeLimit=2
$searcher.Filter=${psQuote(filter)}
$null=$searcher.PropertiesToLoad.Add('sAMAccountName')
$null=$searcher.PropertiesToLoad.Add('userPrincipalName')
$res=$searcher.FindAll()
if ($res.Count -ne 1) { [pscustomobject]@{ ok=$false } | ConvertTo-Json -Compress; exit 0 }
$sam=($res[0].Properties['samaccountname'] | Select-Object -First 1)
$upn=($res[0].Properties['userprincipalname'] | Select-Object -First 1)
[pscustomobject]@{ ok=$true; sam=$sam; upn=$upn } | ConvertTo-Json -Compress
`.trim();

  const r = await runPsJson<{ ok: boolean; sam?: string; upn?: string }>(script, 8000);
  if (!r.ok) return null;
  const normalized = normalizeUserLabel(domainLabel, (r.sam || '').trim(), (r.upn || '').trim());
  if (!normalized) return null;
  return { normalized };
}

export async function isUserInGroup(
  userDomain: string | null,
  userName: string,
  groupDN: string
): Promise<boolean> {
  const sam = stripDomainPrefix(userName);
  if (!sam) return false;

  const filter = `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${escapeLdapFilter(sam)})(memberOf:1.2.840.113556.1.4.1941:=${escapeLdapFilter(groupDN)}))`;

  const script = `
$ErrorActionPreference='Stop'
$root = New-Object System.DirectoryServices.DirectoryEntry('LDAP://RootDSE')
$base = [string]($root.Properties['defaultNamingContext'][0])
if ([string]::IsNullOrWhiteSpace($base)) { throw 'Active Directory not available (domain not joined or DC unreachable)' }
$searchRoot = New-Object System.DirectoryServices.DirectoryEntry(("LDAP://" + $base))
$searcher=New-Object System.DirectoryServices.DirectorySearcher($searchRoot)
$searcher.PageSize=200
$searcher.SizeLimit=1
$searcher.Filter=${psQuote(filter)}
$res=$searcher.FindAll()
[pscustomobject]@{ ok=($res.Count -eq 1) } | ConvertTo-Json -Compress
`.trim();

  const r = await runPsJson<{ ok: boolean }>(script, 8000);
  return !!r.ok;
}

function stripDomainPrefix(v: string): string {
  const m = /^([^\\]+)\\(.+)$/.exec(v.trim());
  return m ? m[2] : v.trim();
}

function normalizeUserLabel(domainLabel: string | null, sam: string, upn: string): string {
  if (domainLabel && sam) return `${domainLabel}\\${sam}`;
  if (upn) return upn;
  if (sam) return sam;
  return '';
}
