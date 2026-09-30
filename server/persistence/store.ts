/** A single-owner local store. A failed write must throw, never report success. */
export interface DurableStore {
  read(key: string): string | null;
  write(key: string, value: string): void;
  close(): void;
}

export type WormDBStoreOptions = {
  dataDir: string;
  libraryPath: string;
};
