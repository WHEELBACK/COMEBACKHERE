import { Pool } from 'pg';

export interface MerchantTransaction {
  id: string;
  merchant_id: string;
  amount: number;
  currency: string;
  status: string;
  created_at: Date;
}

export interface MerchantTransactionQuery {
  merchantId: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export class MerchantTransactionRepository {
  constructor(private readonly pool: Pool) {}

  async findByMerchantAndRange(
    query: MerchantTransactionQuery,
  ): Promise<MerchantTransaction[]> {
    const { merchantId, from, to, limit = 100, offset = 0 } = query;

    const conditions: string[] = ['merchant_id = $1'];
    const params: unknown[] = [merchantId];

    if (from) {
      params.push(from);
      conditions.push(`created_at >= $${params.length}`);
    }

    if (to) {
      params.push(to);
      conditions.push(`created_at <= $${params.length}`);
    }

    params.push(limit, offset);

    // The composite index (merchant_id, created_at DESC) backs this range scan.
    // Keep the predicate on merchant_id and the created_at range so the planner
    // can use an index scan instead of a sequential scan.
    const sql = `
      SELECT id, merchant_id, amount, currency, status, created_at
      FROM merchant_transactions
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `;

    const result = await this.pool.query<MerchantTransaction>(sql, params);
    return result.rows;
  }
}
