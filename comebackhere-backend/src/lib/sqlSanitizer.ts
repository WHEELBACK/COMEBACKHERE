// SQL fragment sanitizer for analytics aggregation queries
export function sanitizeSqlIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function sanitizeAggregationQuery(interval: string, groupByField: string): { interval: string; groupBy: string } {
  const allowedIntervals = ['hour', 'day', 'week', 'month', 'year'];
  const normalizedInterval = interval.toLowerCase();
  if (!allowedIntervals.includes(normalizedInterval)) {
    throw new Error(`Disallowed aggregation interval: ${interval}`);
  }
  const sanitizedGroup = sanitizeSqlIdentifier(groupByField);
  return { interval: normalizedInterval, groupBy: sanitizedGroup };
}
