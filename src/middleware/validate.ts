import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type Target = 'body' | 'params' | 'query';

export function validate(schema: ZodSchema, target: Target = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      return next(result.error);
    }
    // Merge parsed data (coerced/defaulted) into the existing target,
    // so other params like :sourceId / :categoryId / :itemId are preserved.
    (req as unknown as Record<string, unknown>)[target] = {
      ...(req[target] as Record<string, unknown>),
      ...result.data,
    };
    next();
  };
}
