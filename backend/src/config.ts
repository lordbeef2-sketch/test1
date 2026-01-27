import fs from 'node:fs/promises';
import path from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { z } from 'zod';

const computerSchema = z.object({
  computerName: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9\-_.]*$/, 'invalid computerName'),
});

const configSchema = z.object({
  allowedAdGroup: z.string().min(1).max(256),
  detectedDomain: z.string().optional().default(''),
  detectedForest: z.string().optional(),
  refreshSeconds: z.number().int().min(5).max(3600),
  pingTimeoutMs: z.number().int().min(250).max(10_000),
  concurrencyLimit: z.number().int().min(1).max(200),
  tcpProbePort: z.number().int().min(1).max(65_535),
  computers: z.array(computerSchema).min(1).max(10_000),
});

export type AppConfig = z.infer<typeof configSchema>;

export function getConfigPath(): string {
  return process.env.DLT_CONFIG_PATH || path.resolve(__dirname, '../../config.json');
}

export async function loadConfig(): Promise<{ config: AppConfig; configPath: string }>
{
  const configPath = getConfigPath();
  const raw = await fs.readFile(configPath, 'utf8');
  const json = JSON.parse(raw);
  const config = configSchema.parse(json);
  return { config, configPath };
}

export async function saveConfigAtomic(configPath: string, config: AppConfig): Promise<void> {
  const pretty = JSON.stringify(config, null, 2) + '\n';
  await writeFileAtomic(configPath, pretty, { encoding: 'utf8' });
}
