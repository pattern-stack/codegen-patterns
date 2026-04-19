/**
 * ZodValidationPipe
 *
 * Validates an incoming request body (or any decorated value) against a
 * Zod schema at the controller boundary. Intended for use with Nest's
 * `@Body(new ZodValidationPipe(MySchema))` pattern so generated
 * controllers get runtime validation without relying on a global pipe
 * that every consumer would have to opt into.
 *
 * Why a pipe (vs. validating inside the use case): validation is a
 * presentation-layer concern (ADR-003). The use case should receive a
 * type-safe, already-validated DTO; surfacing a `ZodError` at the pipe
 * stage produces the standard 400 BadRequest response shape that HTTP
 * clients expect.
 *
 * On success: returns parsed, coerced data.
 * On failure: throws BadRequestException with a structured `issues` array
 * (path / code / message) — richer than `.flatten()` for API consumers.
 *
 * One pipe instance per route (cheap — instantiated at module load). Keeps
 * validation explicit in the generated code; no metadata/reflection magic.
 *
 * Vendored into consumer projects at `src/shared/pipes/zod-validation.pipe.ts`
 * via `codegen project init` (see init-scaffold's VENDORED_RUNTIME_FILES).
 */
import {
  BadRequestException,
  Injectable,
  PipeTransform,
  type ArgumentMetadata,
} from '@nestjs/common';
import type { ZodIssue, ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe<TSchema extends ZodSchema = ZodSchema>
  implements PipeTransform
{
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      issues: formatIssues(result.error.issues),
    });
  }
}

function formatIssues(issues: readonly ZodIssue[]): Array<{
  path: string;
  code: string;
  message: string;
}> {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
}
