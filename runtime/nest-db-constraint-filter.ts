/**
 * The Nest HTTP answer for a write the database refused on a constraint (`db-constraint-errors.ts`): a 422 for a
 * foreign key that names no row, a 409 for a taken unique value or a still-referenced row — instead of the 500 Nest
 * sends for an error it doesn't know.
 *
 * One global filter is the one owner: every write path (the generated use cases, a service, a family repository's
 * transaction, hand-written code) reaches the database through Drizzle, and its refusal surfaces here. Anything that
 * is not such a violation goes to Nest's own handling unchanged (`BaseExceptionFilter`).
 *
 * `DbConstraintErrorsModule` registers it (`APP_FILTER`); the generated modules barrel lists it first in
 * `GENERATED_MODULES`, so an app gets it by regenerating, with no edit to its own `main.ts` or `AppModule`.
 */
import { Catch, Module, type ArgumentsHost } from '@nestjs/common';
import { APP_FILTER, BaseExceptionFilter } from '@nestjs/core';
import { constraintViolationBody, constraintViolationOf } from './db-constraint-errors';

@Catch()
export class DbConstraintFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const violation = host.getType() === 'http' ? constraintViolationOf(exception) : null;
    const adapter = this.httpAdapterHost?.httpAdapter ?? this.applicationRef;
    if (violation === null || adapter === undefined) {
      super.catch(exception, host);
      return;
    }
    const response = host.switchToHttp().getResponse();
    if (adapter.isHeadersSent(response)) {
      adapter.end(response);
      return;
    }
    adapter.reply(response, constraintViolationBody(violation), violation.status);
  }
}

@Module({
  providers: [{ provide: APP_FILTER, useClass: DbConstraintFilter }],
})
export class DbConstraintErrorsModule {}
