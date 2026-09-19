declare function legacyHelper(value: string): void;

export interface LegacyOptions {
  retries: number;
}

export declare function legacyRun(options: LegacyOptions): void;
