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
