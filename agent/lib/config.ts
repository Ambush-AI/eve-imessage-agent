import { z } from "zod";

const phoneNumber = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, "Expected an E.164 phone number");

const envSchema = z.object({
  /* Sendblue is optional so the agent runs over eve's HTTP channel without a
     phone line; the iMessage channel refuses traffic until all four are set. */
  SENDBLUE_API_KEY: z.string().min(1).optional(),
  SENDBLUE_API_SECRET: z.string().min(1).optional(),
  SENDBLUE_FROM_NUMBER: phoneNumber.optional(),
  SENDBLUE_WEBHOOK_SECRET: z.string().min(1).optional(),
  /**
   * Optional comma-separated E.164 allowlist. Unset means the line is open:
   * anyone who texts it gets their own agent and is onboarded.
   */
  ALLOWED_NUMBERS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean))
    .pipe(z.array(phoneNumber)),
  AMBUSH_API_KEY: z.string().min(1),
  AMBUSH_API_URL: z.string().url().default("https://api.ambush.ai/api/v1"),
  AMBUSH_WEBHOOK_SECRET: z.string().startsWith("whsec_"),
  /** Model turns a person may start per day before the agent asks them to wait. */
  DAILY_TURN_BUDGET: z.coerce.number().int().min(1).default(150),
  /** Streams one conversation may own. */
  MAX_STREAMS_PER_CONVERSATION: z.coerce.number().int().min(1).default(5),
  /** Minutes Ambush waits to batch a stream's items before posting to us. */
  STREAM_BATCH_MINUTES: z.coerce.number().int().min(0).default(10),
  /** Public origin Ambush can reach; defaults to the Vercel production URL. */
  PUBLIC_URL: z.string().url().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function publicBaseUrl(settings: Config): string {
  if (settings.PUBLIC_URL) return settings.PUBLIC_URL;
  if (settings.VERCEL_PROJECT_PRODUCTION_URL) return `https://${settings.VERCEL_PROJECT_PRODUCTION_URL}`;
  throw new Error("Set PUBLIC_URL to the public origin Ambush should post webhooks to");
}

export function numberAllowed(settings: Config, phone: string): boolean {
  return settings.ALLOWED_NUMBERS.length === 0 || settings.ALLOWED_NUMBERS.includes(phone);
}

export function sendblueConfigured(settings: Config): boolean {
  return Boolean(
    settings.SENDBLUE_API_KEY &&
      settings.SENDBLUE_API_SECRET &&
      settings.SENDBLUE_FROM_NUMBER &&
      settings.SENDBLUE_WEBHOOK_SECRET,
  );
}

let cached: Config | undefined;

/**
 * Parsed lazily so module evaluation during `eve build` never needs secrets.
 * Every runtime path that needs credentials calls this instead of process.env.
 */
export function config(): Config {
  cached ??= envSchema.parse(process.env);
  return cached;
}

/** Individual reads for module-scope adapter construction, never throwing. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
