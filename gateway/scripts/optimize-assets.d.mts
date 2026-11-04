export function optimizeAssets(directory: string): Promise<{ removed: string[]; savedBytes: number }>;
export function writeIntegrity(directory: string): Promise<Record<string, { bytes: number; sha256: string }>>;
export function verifyIntegrity(directory: string): Promise<number>;
export function filesWithin(directory: string, prefix?: string): Promise<string[]>;
export function sha256(bytes: Uint8Array): string;
