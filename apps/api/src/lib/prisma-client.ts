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

/**
 * Construct a Prisma client for an explicit database URL.
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
