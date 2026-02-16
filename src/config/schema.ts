/**
 * Zod schema for validated YAML configuration.
 */
import { z } from "zod";

export const appConfigSchema = z.object({
  runner: z.object({
    name: z.string().min(1),
    timezone: z.string().min(1),
    scan_interval_seconds: z.number().int().positive(),
    strategy_root: z.string().min(1),
  }),
  strategies: z.array(
    z.object({
      id: z.string().min(1),
      enabled: z.boolean(),
      directory: z.string().min(1),
    })
  ),
  exchange: z.object({
    bybit: z.object({
      enabled: z.boolean(),
      api_base: z.string().url(),
      request_timeout_ms: z.number().int().positive(),
    }),
  }),
  telegram: z.object({
    enabled: z.boolean(),
    parse_mode: z.enum(["HTML", "Markdown", "MarkdownV2"]),
    send_delay_ms: z.number().int().nonnegative(),
  }),
});

export type RawAppConfig = z.infer<typeof appConfigSchema>;
