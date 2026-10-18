import type { ZodType } from "zod"

export function expectResponseShape<T>(body: unknown, schema: ZodType<T>): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`Response shape mismatch: ${parsed.error.message}`)
  }
  return parsed.data
}