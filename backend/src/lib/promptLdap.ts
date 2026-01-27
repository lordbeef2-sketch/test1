import readline from 'node:readline';

type PromptResult = {
  url: string;
  bindDN: string;
  bindPassword: string;
  baseDN: string;
};

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

async function askHidden(rl: readline.Interface, q: string): Promise<string> {
  const anyRl = rl as any;
  anyRl.stdoutMuted = true;
  const old = anyRl._writeToOutput;
  anyRl._writeToOutput = function _writeToOutput(this: any, stringToWrite: string) {
    if (this.stdoutMuted) {
      // Mask everything except newlines.
      if (stringToWrite.includes('\n') || stringToWrite.includes('\r')) {
        this.output.write(stringToWrite);
      } else {
        this.output.write('*');
      }
    } else {
      this.output.write(stringToWrite);
    }
  };

  try {
    const v = await ask(rl, q);
    return v;
  } finally {
    anyRl.stdoutMuted = false;
    anyRl._writeToOutput = old;
  }
}

export async function promptLdapConfigIfMissing(): Promise<void> {
  const needed = ['DLT_LDAP_URL', 'DLT_LDAP_BIND_DN', 'DLT_LDAP_BIND_PASSWORD', 'DLT_LDAP_BASE_DN'] as const;
  const missing = needed.filter((k) => !process.env[k] || !process.env[k]!.trim());
  if (missing.length === 0) return;

  if (!process.stdin.isTTY) {
    throw new Error(
      `Missing LDAP configuration (${missing.join(', ')}). ` +
        'Set environment variables or run interactively to be prompted.'
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    const url = (process.env.DLT_LDAP_URL || (await ask(rl, 'LDAP URL (e.g. ldaps://dc:636): '))).trim();
    const bindDN = (process.env.DLT_LDAP_BIND_DN || (await ask(rl, 'LDAP Bind DN: '))).trim();
    const bindPassword = (process.env.DLT_LDAP_BIND_PASSWORD || (await askHidden(rl, 'LDAP Bind Password: '))).trim();
    const baseDN = (process.env.DLT_LDAP_BASE_DN || (await ask(rl, 'LDAP Base DN (e.g. DC=domain,DC=local): '))).trim();

    if (!url || !bindDN || !bindPassword || !baseDN) {
      throw new Error('LDAP configuration is incomplete.');
    }

    // Store only in-memory for this process.
    process.env.DLT_LDAP_URL = url;
    process.env.DLT_LDAP_BIND_DN = bindDN;
    process.env.DLT_LDAP_BIND_PASSWORD = bindPassword;
    process.env.DLT_LDAP_BASE_DN = baseDN;
  } finally {
    rl.close();
  }
}
