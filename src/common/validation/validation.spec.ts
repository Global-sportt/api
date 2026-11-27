import { ValidationPipe } from '@nestjs/common';
import { IsString } from 'class-validator';
import { AppError } from '../errors/app-error';
import { createValidationPipe, flattenValidationErrors } from './validation';

class SampleDto {
  @IsString()
  name!: string;
}

describe('validation helpers', () => {
  it('flattens nested class-validator errors with dotted field paths', () => {
    const issues = flattenValidationErrors([
      {
        property: 'spaceId',
        constraints: { isUuid: 'spaceId must be a UUID' },
        children: [],
      },
      {
        property: 'schedule',
        children: [
          {
            property: 'startsAt',
            constraints: {
              isIso8601: 'startsAt must be an ISO date',
              isDefined: 'startsAt should not be null',
            },
            children: [],
          },
        ],
      },
    ]);

    expect(issues).toEqual([
      { field: 'spaceId', constraints: ['spaceId must be a UUID'] },
      {
        field: 'schedule.startsAt',
        constraints: [
          'startsAt must be an ISO date',
          'startsAt should not be null',
        ],
      },
    ]);
  });

  it('returns an empty list for valid or constraint-free nodes', () => {
    expect(flattenValidationErrors([])).toEqual([]);
    expect(
      flattenValidationErrors([{ property: 'note', children: [] }]),
    ).toEqual([]);
  });

  it('creates a strict whitelist pipe and maps failures to AppError', async () => {
    const pipe = createValidationPipe();
    expect(pipe).toBeInstanceOf(ValidationPipe);

    const error = await pipe
      .transform(
        { name: 42, unexpected: true },
        { type: 'body', metatype: SampleDto },
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.getStatus()).toBe(400);
    expect(appError.code).toBe('VALIDATION_ERROR');
    expect(appError.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'name' }),
        expect.objectContaining({ field: 'unexpected' }),
      ]),
    );
  });
});
