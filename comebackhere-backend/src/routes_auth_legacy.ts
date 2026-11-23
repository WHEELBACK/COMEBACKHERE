import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodError, ZodSchema } from 'zod';

/**
 * Legacy auth routes.
 *
 * This module previously contained a number of unguarded handlers that could
 * throw during high load (missing body, malformed params, undefined user
 * lookups, etc.). The routes below are hardened with:
 *   - schema-based validation for body / params / query
 *   - asyncHandler wrapping so rejected promises reach the error middleware
 *   - typed application errors
 *   - null / undefined guards
 *   - a single, standard error envelope
 */

/* -------------------------------------------------------------------------- */
/*                                  Errors                                    */
/* -------------------------------------------------------------------------- */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, 'CONFLICT', message);
    this.name = 'ConflictError';
  }
}

/* -------------------------------------------------------------------------- */
/*                              Error envelope                                */
/* -------------------------------------------------------------------------- */

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export function buildErrorEnvelope(err: unknown): { statusCode: number; body: ErrorEnvelope } {
  if (err instanceof AppError) {
    const body: ErrorEnvelope = {
      error: {
        code: err.code,
        message: err.message,
      },
    };
    if (err.details !== undefined) {
      body.error.details = err.details;
    }
    return { statusCode: err.statusCode, body };
  }

  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request',
          details: err.issues,
        },
      },
    };
  }

  return {
    statusCode: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                                asyncHandler                                */
/* -------------------------------------------------------------------------- */

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/* -------------------------------------------------------------------------- */
/*                              Validation helper                             */
/* -------------------------------------------------------------------------- */

interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

function validate<T>(schema: ZodSchema<T> | undefined, value: unknown, label: string): T | undefined {
  if (!schema) return undefined;
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid ${label}`, result.error.issues);
  }
  return result.data;
}

function validateRequest(req: Request, schemas: ValidationSchemas): void {
  const body = validate(schemas.body, req.body ?? {}, 'body');
  const params = validate(schemas.params, req.params ?? {}, 'params');
  const query = validate(schemas.query, req.query ?? {}, 'query');

  if (body !== undefined) req.body = body;
  if (params !== undefined) req.params = params as Request['params'];
  if (query !== undefined) req.query = query as Request['query'];
}

/* -------------------------------------------------------------------------- */
/*                                  Schemas                                   */
/* -------------------------------------------------------------------------- */

const emailSchema = z.string().trim().toLowerCase().email().max(320);

const passwordSchema = z.string().min(8).max(128);

const loginBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const registerBodySchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(200).optional(),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1).max(4096),
});

const logoutBodySchema = z.object({
  refreshToken: z.string().min(1).max(4096).optional(),
});

const userIdParamsSchema = z.object({
  userId: z.string().min(1).max(128),
});

const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/* -------------------------------------------------------------------------- */
/*                              Service contracts                             */
/* -------------------------------------------------------------------------- */

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthService {
  login(email: string, password: string): Promise<{ user: AuthUser; tokens: AuthTokens }>;
  register(input: { email: string; password: string; name?: string }): Promise<{ user: AuthUser; tokens: AuthTokens }>;
  refresh(refreshToken: string): Promise<AuthTokens>;
  logout(refreshToken: string | undefined): Promise<void>;
  getUserById(userId: string): Promise<AuthUser | null>;
  listUsers(limit: number, offset: number): Promise<AuthUser[]>;
}

/* -------------------------------------------------------------------------- */
/*                                  Router                                    */
/* -------------------------------------------------------------------------- */

export interface AuthRouterDeps {
  authService: AuthService;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const { authService } = deps;
  if (!authService) {
    throw new Error('createAuthRouter requires an authService');
  }

  const router = Router();

  /* ------------------------------- login -------------------------------- */

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      validateRequest(req, { body: loginBodySchema });
      const { email, password } = req.body as z.infer<typeof loginBodySchema>;

      const result = await authService.login(email, password);
      if (!result || !result.user || !result.tokens) {
        throw new UnauthorizedError('Invalid credentials');
      }

      res.status(200).json({
        user: result.user,
        tokens: result.tokens,
      });
    }),
  );

  /* ------------------------------ register ------------------------------ */

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      validateRequest(req, { body: registerBodySchema });
      const input = req.body as z.infer<typeof registerBodySchema>;

      const result = await authService.register(input);
      if (!result || !result.user || !result.tokens) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Registration failed');
      }

      res.status(201).json({
        user: result.user,
        tokens: result.tokens,
      });
    }),
  );

  /* ------------------------------- refresh ------------------------------ */

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      validateRequest(req, { body: refreshBodySchema });
      const { refreshToken } = req.body as z.infer<typeof refreshBodySchema>;

      const tokens = await authService.refresh(refreshToken);
      if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
        throw new UnauthorizedError('Invalid refresh token');
      }

      res.status(200).json({ tokens });
    }),
  );

  /* ------------------------------- logout ------------------------------- */

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      validateRequest(req, { body: logoutBodySchema });
      const { refreshToken } = req.body as z.infer<typeof logoutBodySchema>;

      await authService.logout(refreshToken);
      res.status(204).send();
    }),
  );

  /* ------------------------------ get user ------------------------------ */

  router.get(
    '/users/:userId',
    asyncHandler(async (req, res) => {
      validateRequest(req, { params: userIdParamsSchema });
      const { userId } = req.params as z.infer<typeof userIdParamsSchema>;

      const user = await authService.getUserById(userId);
      if (!user) {
        throw new NotFoundError('User not found');
      }

      res.status(200).json({ user });
    }),
  );

  /* ------------------------------ list users ---------------------------- */

  router.get(
    '/users',
    asyncHandler(async (req, res) => {
      validateRequest(req, { query: paginationQuerySchema });
      const { limit, offset } = req.query as z.infer<typeof paginationQuerySchema>;

      const users = await authService.listUsers(limit ?? 20, offset ?? 0);
      if (!Array.isArray(users)) {
        throw new AppError(500, 'INTERNAL_ERROR', 'Failed to list users');
      }

      res.status(200).json({ users });
    }),
  );

  /* --------------------------- error middleware ------------------------- */

  router.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const { statusCode, body } = buildErrorEnvelope(err);
    res.status(statusCode).json(body);
  });

  return router;
}

export default createAuthRouter;