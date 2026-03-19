import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Zod validation error
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation error',
      details: err.flatten().fieldErrors,
    });
    return;
  }

  // Application-level error
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  // Prisma: record not found
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'Resource not found' });
      return;
    }
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'Unique constraint violation' });
      return;
    }
  }

  // Unknown error
  const message = err instanceof Error ? err.message : 'Internal server error';
  console.error('[Unhandled error]', err);

  res.status(500).json({
    error: 'Internal server error',
    ...(env.NODE_ENV === 'development' && { message }),
  });
}
