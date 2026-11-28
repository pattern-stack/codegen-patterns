/**
 * The body of a request a schema refused (H-1). Framework-free: Nest's `ZodValidationPipe` throws it, and a command's
 * `invalid-input` refusal carries it, so every way in answers a bad input with the same body (the REST parity gate).
 * The codes and messages are Zod 4's (`invalid_value`, `invalid_format`, …; ZOD-1).
 */

/** One problem with an input, as Zod reports it. */
export interface ValidationIssueInput {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

export interface ValidationErrorBody {
  readonly statusCode: 400;
  readonly error: 'Bad Request';
  readonly message: 'Validation failed';
  readonly issues: ReadonlyArray<{ path: string; code: string; message: string }>;
}

export function validationErrorBody(issues: readonly ValidationIssueInput[]): ValidationErrorBody {
  return {
    statusCode: 400,
    error: 'Bad Request',
    message: 'Validation failed',
    issues: issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message })),
  };
}
