import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32),
    SESSION_COOKIE_NAME: z.string().default('sid'),
    // Sliding session: kick idle users after SESSION_IDLE_MS (default 2h),
    // but a session can never live past SESSION_ABSOLUTE_MS (default 14d) from creation.
    // lastSeenAt is only written when it's older than SESSION_TOUCH_MIN_INTERVAL_MS (default 5min).
    SESSION_IDLE_MS: z.coerce.number().int().positive().default(2 * 60 * 60 * 1000),
    SESSION_ABSOLUTE_MS: z.coerce.number().int().positive().default(14 * 24 * 60 * 60 * 1000),
    SESSION_TOUCH_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(5 * 60 * 1000),
    // Max time the process waits for in-flight requests to finish after SIGTERM
    // before it force-closes. Long enough to let a game-upload complete finalize (15s default).
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().default(15_000),
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
    // Legacy local storage paths — only used by migration script
    UPLOAD_ROOT_PROTECTED: z.string().default('/app/storage/protected').optional(),
    UPLOAD_ROOT_PUBLIC: z.string().default('/app/storage/public').optional(),
    AUTO_PUBLISH_DEFAULT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),

    // Reverse proxy trust — set to 'true' if behind a single proxy (nginx, etc.),
    // or a number for the hop count, or a comma-separated list of trusted IPs.
    // Leave empty or 'false' when the API is directly exposed (no proxy).
    TRUST_PROXY: z.string().default('false'),

    // ── Rate limits (req per window, per client IP) ──────────
    // Global baseline for every route not explicitly allowlisted. Kept permissive
    // so legitimate traffic (page-of-projects listing, thumbnails) never trips it.
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    // Login endpoint — tight because credential stuffing is the common abuse.
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(20),
    RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    // Project submit — uploads are a rare, heavyweight action.
    RATE_LIMIT_SUBMIT_MAX: z.coerce.number().int().positive().default(30),
    RATE_LIMIT_SUBMIT_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),

    // ── Upload limits (MB / count) ──────────────────────────
    // USER limits (tighter — for regular students)
    UPLOAD_USER_IMAGE_MAX_MB: z.coerce.number().positive().default(10),
    UPLOAD_USER_GAME_MAX_MB: z.coerce.number().positive().default(5120),
    UPLOAD_USER_REQUEST_MAX_MB: z.coerce.number().positive().default(250),
    UPLOAD_USER_MAX_FILES: z.coerce.number().int().positive().default(10),
    // OPERATOR/ADMIN limits (relaxed — for staff reviewing or importing)
    UPLOAD_PRIVILEGED_IMAGE_MAX_MB: z.coerce.number().positive().default(15),
    UPLOAD_PRIVILEGED_GAME_MAX_MB: z.coerce.number().positive().default(5120),
    UPLOAD_PRIVILEGED_REQUEST_MAX_MB: z.coerce.number().positive().default(1200),
    UPLOAD_PRIVILEGED_MAX_FILES: z.coerce.number().int().positive().default(20),
    // Global concurrent upload limit (all users combined)
    UPLOAD_MAX_CONCURRENT: z.coerce.number().int().positive().default(5),
    // ── Chunked game upload ─────────────────────────────────
    UPLOAD_CHUNKED_GAME_MAX_MB: z.coerce.number().positive().default(5120),   // 5 GB
    UPLOAD_CHUNK_SIZE_MB: z.coerce.number().positive().default(10),           // 10 MB per chunk
    // UPLOAD_STAGING_ROOT removed — chunked uploads now use S3 multipart
    UPLOAD_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(1440), // 24 hours

    // ── S3-compatible object storage (Garage) ─────────────
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().default('garage'),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_BUCKET_PUBLIC: z.string().default('pcu-public'),
    S3_BUCKET_PROTECTED: z.string().default('pcu-protected'),
    S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    S3_PRESIGN_TTL_SEC: z.coerce.number().int().positive().default(60),

    // ── NAS export ──────────────────────────────────────
    // Mount path where exported asset files are written (e.g. /mnt/nas)
    NAS_EXPORT_PATH: z.string().optional(),
  })
;

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

/**
 * Fixed-phrase hint per Zod issue code. Intentionally does NOT consult
 * `issue.message` or any received value — some codes (e.g. `invalid_enum_value`)
 * default to messages that include the offending value, and env values can be
 * secrets. Keeping the hint constant guarantees nothing sensitive leaks to stderr.
 */
const ENV_ISSUE_HINT: Record<string, string> = {
  invalid_type: 'is missing or has the wrong type',
  invalid_string: 'is not a valid string (url / email / regex)',
  too_small: 'is shorter or smaller than required',
  too_big: 'is longer or larger than allowed',
  invalid_enum_value: 'must be one of the allowed values',
  invalid_union: 'does not match any accepted shape',
  invalid_literal: 'does not match the required literal',
  custom: 'failed a custom validation rule',
};

/**
 * Format Zod env-validation issues into one line per field — `PATH: hint`.
 *
 * Deliberately ignores `issue.message` and any other value-derived text, so we
 * can't accidentally print the contents of, e.g., `SESSION_SECRET` or a token
 * that was supposed to be a URL. The hint column uses {@link ENV_ISSUE_HINT}
 * by code alone.
 */
export function formatEnvIssues(issues: z.ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    const hint = ENV_ISSUE_HINT[issue.code] ?? `failed validation (${issue.code})`;
    return `  - ${path}: ${hint}`;
  });
}

export function loadEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    for (const line of formatEnvIssues(result.error.issues)) {
      console.error(line);
    }
    process.exit(1);
  }
  _env = result.data;
  if (!_env.ALLOWED_GOOGLE_HD) {
    console.warn(
      '⚠  ALLOWED_GOOGLE_HD is empty — any Google account can sign up. Set it to your institution domain (e.g. "g.pcu.ac.kr") in production.',
    );
  }
  return _env;
}

export function env(): Env {
  if (!_env) return loadEnv();
  return _env;
}
