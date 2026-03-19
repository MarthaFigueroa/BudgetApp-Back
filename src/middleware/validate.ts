import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

type Target = 'body' | 'params' | 'query';

export function validate(schema: ZodSchema, target: Target = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      return next(result.error);
    }
    // Replace the target with the parsed (coerced/defaulted) data
    (req as unknown as Record<string, unknown>)[target] = result.data;
    next();
  };
}
