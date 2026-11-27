import { z } from 'zod';

const invoiceLineItemSchema = z.object({
  description: z.string().min(1, 'Line item description is required'),
  quantity: z.number().int().positive('Quantity must be a positive integer'),
  unitPrice: z.number().nonnegative('Unit price must be non-negative'),
  amount: z.number().nonnegative('Amount must be non-negative').optional(),
});

const invoiceBaseSchema = z.object({
  merchantId: z.string().min(1, 'merchantId is required'),
  customerId: z.string().min(1, 'customerId is required').optional(),
  currency: z.string().length(3, 'currency must be a 3-letter ISO code').toUpperCase(),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()),
  lineItems: z.array(invoiceLineItemSchema).min(1, 'At least one line item is required'),
  notes: z.string().max(2000, 'notes must be 2000 characters or fewer').optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createInvoiceSchema = invoiceBaseSchema.strict();

export const updateInvoiceSchema = invoiceBaseSchema
  .partial()
  .extend({
    status: z.enum(['draft', 'open', 'paid', 'void', 'overdue']).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  });

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

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

function formatIssues(error: z.ZodError): ValidationErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; status: 400; body: ValidationErrorResponse };

function validate<T>(schema: z.ZodType<T>, payload: unknown): ValidationResult<T> {
  const result = schema.safeParse(payload);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    status: 400,
    body: {
      error: 'Bad Request',
      message: 'Invoice payload validation failed',
      details: formatIssues(result.error),
    },
  };
}

export function validateCreateInvoice(payload: unknown): ValidationResult<CreateInvoiceInput> {
  return validate(createInvoiceSchema, payload);
}

export function validateUpdateInvoice(payload: unknown): ValidationResult<UpdateInvoiceInput> {
  return validate(updateInvoiceSchema, payload);
}
