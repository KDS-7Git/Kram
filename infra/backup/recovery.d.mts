export interface RecoveryPoint { id: string; createdAt: string; timezone?: string }
export function retainedIds(manifests: RecoveryPoint[]): Set<string>;
export function pruneRecovery(directory?: string): Promise<{ kept: string[]; removed: string[] }>;
export function runEncryptedBackup(options?: { periodKey?: string; verify?: boolean; now?: Date }): Promise<Record<string, unknown>>;
export function verifyEncryptedBackup(file: string): Promise<Record<string, unknown>>;
