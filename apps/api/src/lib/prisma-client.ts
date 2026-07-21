import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

type PrismaClientOptions = Omit<
  NonNullable<ConstructorParameters<typeof PrismaClient>[0]>,
  'adapter' | 'accelerateUrl'
>;

function schemaFromDatabaseUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('schema') ?? undefined;
  } catch {
    return undefined;
  }
}

function createPrismaAdapter(databaseUrl: string): PrismaPg {
  return new PrismaPg(
    {
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 300_000,
    },
    { schema: schemaFromDatabaseUrl(databaseUrl) },
  );
}

export function createPrismaClient(
  options?: PrismaClientOptions,
): PrismaClient {
  return createPrismaClientForDatabase(process.env['DATABASE_URL'] ?? '', options);
}

/**
 * Production composition entry point. Unlike the compatibility helper above,
 * this never consults process.env and therefore cannot silently connect a
 * context to a different database than the config it was built with.
 */
export function createPrismaClientForDatabase(
  databaseUrl: string,
  options?: PrismaClientOptions,
): PrismaClient {
  return new PrismaClient({
    ...options,
    adapter: createPrismaAdapter(databaseUrl),
  });
}
