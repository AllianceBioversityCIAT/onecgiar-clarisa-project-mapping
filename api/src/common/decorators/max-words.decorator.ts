import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Count words the same way the web form and the center-rep importer do:
 * trim, then split on any run of whitespace. Empty / non-string → 0 words.
 * Keeping this identical across all three surfaces means a value accepted
 * by one is accepted by the others.
 */
export function countWords(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Validates that a string contains at most `max` whitespace-separated words.
 * Null/undefined/empty pass (pair with `@IsOptional()` for optional fields).
 * Mirrors the frontend `maxWords()` validator in project-form.component.ts.
 */
export function MaxWords(max: number, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'maxWords',
      target: object.constructor,
      propertyName,
      constraints: [max],
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          // Only string values are word-counted; non-strings are left to
          // @IsString() to reject and pass this check trivially.
          if (typeof value !== 'string') return true;
          return countWords(value) <= max;
        },
        defaultMessage(args: ValidationArguments): string {
          const [limit] = args.constraints as [number];
          return `${args.property} must be ${limit} words or fewer (got ${countWords(args.value)}).`;
        },
      },
    });
  };
}
