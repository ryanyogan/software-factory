export type ErrorCode =
  | 'unknown_command'
  | 'invalid_input'
  | 'invalid_output'
  | 'not_found'
  | 'unauthorized'
  | 'internal';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; issues?: unknown };
}

const statusByCode: Record<ErrorCode, number> = {
  unknown_command: 404,
  invalid_input: 400,
  invalid_output: 500,
  not_found: 404,
  unauthorized: 401,
  internal: 500,
};

/** Error thrown by dispatch/handlers and by the HTTP client. Serialisable via `toBody()`. */
export class CommandError extends Error {
  readonly code: ErrorCode;
  readonly issues?: unknown;

  constructor(code: ErrorCode, message: string, issues?: unknown) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.issues = issues;
  }

  get status(): number {
    return statusByCode[this.code];
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.issues === undefined ? {} : { issues: this.issues }),
      },
    };
  }
}
