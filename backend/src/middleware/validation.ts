import { Request, Response, NextFunction } from 'express';
import { z, ZodError, ZodSchema } from 'zod';

export interface ValidationErrorDetail {
  path: string;
  message: string;
  code: string;
}

export interface ValidationErrorResponse {
  error: 'Bad Request';
  message: string;
  details: ValidationErrorDetail[];
}

const invoiceLineItemSchema = z.object({
  description: z.string().min(1, 'Line item description is required'),
  quantity: z.number().int().positive('Quantity must be a positive integer'),
  unitPrice: z.number().nonnegative('Unit price must be non-negative'),
  taxRate: z.number().min(0).max(100).optional(),
});

export const createInvoiceSchema = z.object({
  merchantId: z.string().uuid('merchantId must be a valid UUID'),
  customerId: z.string().uuid('customerId must be a valid UUID').optional(),
  invoiceNumber: z.string().min(1, 'invoiceNumber is required').max(64),
  currency: z.string().length(3, 'currency must be a 3-letter ISO code').toUpperCase(),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()),
  lineItems: z.array(invoiceLineItemSchema).min(1, 'At least one line item is required'),
  notes: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateInvoiceSchema = z.object({
  customerId: z.string().uuid('customerId must be a valid UUID').optional(),
  currency: z.string().length(3, 'currency must be a 3-letter ISO code').toUpperCase().optional(),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  lineItems: z.array(invoiceLineItemSchema).min(1, 'At least one line item is required').optional(),
  notes: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(['draft', 'pending', 'paid', 'void', 'overdue']).optional(),
});

export type CreateInvoicePayload = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoicePayload = z.infer<typeof updateInvoiceSchema>;

function formatZodError(error: ZodError): ValidationErrorDetail[] {
  return error.errors.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const body: ValidationErrorResponse = {
        error: 'Bad Request',
        message: 'Invoice payload validation failed',
        details: formatZodError(result.error),
      };
      res.status(400).json(body);
      return;
    }
    req.body = result.data;
    next();
  };
}

export const validateCreateInvoice = validateBody(createInvoiceSchema);
export const validateUpdateInvoice = validateBody(updateInvoiceSchema);
