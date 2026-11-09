export declare const CALLBACK_ENV_KEYS: readonly string[];

export declare function stripCallbackEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export declare function testEnvironment(env?: NodeJS.ProcessEnv, explicit?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliSettings {
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export declare function runCli(bundle: string, args: readonly string[], settings?: CliSettings): Promise<CliResult>;

/** A parsed plain-text CLI result: the metadata line and the text it carried. */
export interface ParsedJobResult {
  readonly id: string;
  readonly status: string;
  readonly exitCode: number | null;
  readonly cursor: number;
  readonly truncated: boolean;
  readonly output: string;
  readonly logPath: string;
}

export declare function parseJobOutput(stdout: string): ParsedJobResult;
