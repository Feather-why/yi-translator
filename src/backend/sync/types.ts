export interface LwwRecord { value?: unknown; updatedAt: number; deviceId: string; deleted?: boolean }
export type UsageCounters = Record<string, Record<string, Record<string, number>>>;
export interface SyncDocument { version: 1; fields: Record<string, LwwRecord>; usage: UsageCounters; secrets?: Record<string, Record<string, string>> }
export interface SyncStore {
  export(includeSecrets?: boolean): Promise<SyncDocument>;
  import(document: SyncDocument): Promise<void>;
}
export interface LocalArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
export interface SyncConfig { enabled: boolean; url: string; syncSecrets?: boolean; username?: string; password?: string; passphrase?: string }
