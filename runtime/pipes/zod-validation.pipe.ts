/**
 * ZodValidationPipe
 *
 * NestJS pipe that runs a Zod schema against the pipe's input and:
 *   - returns parsed, coerced data on success,
 *   - throws a BadRequestException with `result.error.flatten()` on failure.
 *
 * Generated controllers wire it into write-route @Body():
 *   @Body(new ZodValidationPipe(CreateXSchema)) dto: CreateXDto
 *
 * One pipe instance per route (cheap — instantiated at module load). Keeps
 * validation explicit in the generated code; no metadata/reflection magic.
 */
import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodTypeAny } from 'zod';

@Injectable()
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.flatten());
    }
    return result.data;
  }
}
