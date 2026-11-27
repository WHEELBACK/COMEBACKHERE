import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { invoiceService } from '../services/invoice.service';
import { authenticate } from '../middleware/auth';

const router = Router();

const lineItemSchema = z.object({
  description: z.string().min(1, 'description is required'),
  quantity: z.number().int().positive('quantity must be a positive integer'),
  unitPrice: z.number().nonnegative('unitPrice must be non-negative'),
  taxRate: z.number().min(0).max(100).optional(),
});

const createInvoiceSchema = z.object({
  merchantId: z.string().min(1, 'merchantId is required'),
  customerId: z.string().min(1, 'customerId is required'),
  currency: z.string().length(3, 'currency must be a 3-letter ISO code'),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()),
  lineItems: z.array(lineItemSchema).min(1, 'at least one line item is required'),
  notes: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateInvoiceSchema = z.object({
  customerId: z.string().min(1).optional(),
  currency: z.string().length(3, 'currency must be a 3-letter ISO code').optional(),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  lineItems: z.array(lineItemSchema).min(1, 'at least one line item is required').optional(),
  notes: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
  status: z.enum(['draft', 'sent', 'paid', 'void']).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'at least one field must be provided for update',
});

function validateBody(schema: z.ZodTypeAny) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invoice payload validation failed',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }
    req.body = result.data;
    return next();
  };
}

router.post('/', authenticate, validateBody(createInvoiceSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoice = await invoiceService.createInvoice(req.body);
    res.status(201).json(invoice);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', authenticate, validateBody(updateInvoiceSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoice = await invoiceService.updateInvoice(req.params.id, req.body);
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

export default router;
