import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { AppError } from '../errors/app-error';

export interface ValidationIssue {
  field: string;
  constraints: string[];
}

export function flattenValidationErrors(
  errors: ValidationError[],
  parent = '',
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) {
      issues.push({
        field,
        constraints: Object.values(error.constraints),
      });
    }
    if (error.children && error.children.length > 0) {
      issues.push(...flattenValidationErrors(error.children, field));
    }
  }

  return issues;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: false,
    exceptionFactory: (errors: ValidationError[]) =>
      new AppError(
        400,
        'VALIDATION_ERROR',
        'La petición contiene datos inválidos.',
        flattenValidationErrors(errors),
      ),
  });
}
