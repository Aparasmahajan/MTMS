import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { parseBody } from '../api';
import { ServiceError } from '../errors';

/**
 * `parseBody` used to call `request.json()`, which rejects on an empty body — so the
 * defects table, which cycles a status with a bodyless PATCH, failed with "Expected a
 * JSON body" instead of advancing. An absent body is now `{}`.
 */

function patch(body?: string): NextRequest {
  return new Request('https://tracker.test/api/v1/defects/1', {
    method: 'PATCH',
    ...(body === undefined ? {} : { body }),
  }) as NextRequest;
}

const Optional = z.object({ status: z.enum(['Open', 'Fixed']).optional() });

describe('parseBody', () => {
  it('reads an absent body as no fields', async () => {
    await expect(parseBody(patch(), Optional)).resolves.toEqual({});
  });

  it('reads a whitespace-only body as no fields', async () => {
    await expect(parseBody(patch('  \n '), Optional)).resolves.toEqual({});
  });

  it('reads a body that is there', async () => {
    await expect(parseBody(patch('{"status":"Fixed"}'), Optional)).resolves.toEqual({
      status: 'Fixed',
    });
  });

  it('still rejects a body that is present but not JSON', async () => {
    await expect(parseBody(patch('not json'), Optional)).rejects.toBeInstanceOf(ServiceError);
  });

  it('still applies the schema to an absent body, so required fields fail on their own terms', async () => {
    const Required = z.object({ name: z.string() });
    await expect(parseBody(patch(), Required)).rejects.toThrowError();
  });

  it('applies schema defaults to an absent body', async () => {
    const WithDefault = z.object({ add_to_library: z.boolean().default(false) });
    await expect(parseBody(patch(), WithDefault)).resolves.toEqual({ add_to_library: false });
  });
});
