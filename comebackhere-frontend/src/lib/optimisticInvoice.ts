// Optimistic invoice status update helper with automatic rollback
export interface InvoiceState {
  id: string;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  updatedAt: number;
}

export class OptimisticInvoiceManager {
  private cache: Map<string, InvoiceState> = new Map();
  private backups: Map<string, InvoiceState> = new Map();

  setInvoice(invoice: InvoiceState) {
    this.cache.set(invoice.id, { ...invoice });
  }

  applyOptimisticStatus(id: string, newStatus: InvoiceState['status']): InvoiceState | null {
    const current = this.cache.get(id);
    if (!current) return null;
    this.backups.set(id, { ...current });
    const updated: InvoiceState = { ...current, status: newStatus, updatedAt: Date.now() };
    this.cache.set(id, updated);
    return updated;
  }

  rollback(id: string): InvoiceState | null {
    const backup = this.backups.get(id);
    if (!backup) return null;
    this.cache.set(id, backup);
    this.backups.delete(id);
    return backup;
  }

  commit(id: string) {
    this.backups.delete(id);
  }

  getInvoice(id: string): InvoiceState | undefined {
    return this.cache.get(id);
  }
}
