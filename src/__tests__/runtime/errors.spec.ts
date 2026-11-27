/**
 * Plain application errors (PW-0): each renders the body Nest's exception of the
 * same status sends, key for key and in Nest's key order, so a non-Nest HTTP
 * layer answers as the Nest twin does.
 */
import { describe, expect, it } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import {
  AppError,
  BadRequestError,
  errorBody,
  isAppError,
  NotFoundError,
} from '../../../runtime/errors';

/** What Nest sends for an exception (`getResponse()` is the JSON body). */
const nestBody = (e: NotFoundException | BadRequestException) => e.getResponse();

describe('plain errors', () => {
  it('NotFoundError renders the body of NotFoundException(message)', () => {
    const message = 'Contact not found: c-1';
    const body = errorBody(new NotFoundError(message));
    expect(body).toEqual(nestBody(new NotFoundException(message)) as object);
    expect(JSON.stringify(body)).toBe(JSON.stringify(nestBody(new NotFoundException(message))));
  });

  it('BadRequestError with a code renders the object body the list use case sends', () => {
    const message = "sort_by 'name' is a column of base and cannot be combined with this filter in v1";
    const body = errorBody(new BadRequestError(message, { code: 'sort_not_combinable' }));
    const nest = new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'sort_not_combinable',
      message,
    });
    expect(JSON.stringify(body)).toBe(JSON.stringify(nestBody(nest)));
  });

  it('puts details between the code and the message, as the include refusal does', () => {
    const body = errorBody(
      new BadRequestError("include not allowed: 'x'", { code: 'include_not_allowed', details: { path: 'x' } }),
    );
    const nest = new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'include_not_allowed',
      path: 'x',
      message: "include not allowed: 'x'",
    });
    expect(JSON.stringify(body)).toBe(JSON.stringify(nestBody(nest)));
  });

  it('carries status, name and cause, and is recognised by isAppError', () => {
    const cause = new Error('row missing');
    const err = new NotFoundError('gone', { cause });
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(404);
    expect(err.name).toBe('NotFoundError');
    expect(err.cause).toBe(cause);
    expect(new BadRequestError('no').status).toBe(400);
    expect(isAppError(err)).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
  });
});

describe('details', () => {
  it('refuses a detail that would shadow a key the body owns', () => {
    for (const key of ['statusCode', 'error', 'code', 'message']) {
      expect(() => new BadRequestError('m', { details: { [key]: 500 } })).toThrow(TypeError);
    }
  });
});
