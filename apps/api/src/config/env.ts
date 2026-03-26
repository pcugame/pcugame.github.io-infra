import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32),
    SESSION_COOKIE_NAME: z.string().default('sid'),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('lax'),
    GOOGLE_CLIENT_IDS: z
      .string()
      .min(1, 'GOOGLE_CLIENT_IDS must not be empty — OAuth login will not work without at least one client ID')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
      .refine((arr) => arr.length > 0, 'GOOGLE_CLIENT_IDS must contain at least one valid client ID'),
    ALLOWED_GOOGLE_HD: z.string().default(''),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .min(1, 'CORS_ALLOWED_ORIGINS must not be empty — the server needs at least one allowed origin')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
      .refine((arr) => arr.length > 0, 'CORS_ALLOWED_ORIGINS must contain at least one valid origin'),
    API_PUBLIC_URL: z.string().url(),
    WEB_PUBLIC_URL: z.string().url(),
    UPLOAD_ROOT_PROTECTED: z.string().default('/app/storage/protected'),
    UPLOAD_ROOT_PUBLIC: z.string().default('/app/storage/public'),
    AUTO_PUBLISH_DEFAULT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
  })
;

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function loadEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    console.error(result.error.flatten().fieldErrors);
    process.exit(1);
  }
  _env = result.data;
  return _env;
}

export function env(): Env {
  if (!_env) return loadEnv();
  return _env;
}
