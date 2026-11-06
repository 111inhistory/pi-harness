/** A task operation the caller can act on. */
export class AsyncShellError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AsyncShellError";
    this.code = code;
  }
}
