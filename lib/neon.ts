import { neon } from "@neondatabase/serverless";

const DATABASE_ENV_NAMES = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
] as const;

type DatabaseEnvName = (typeof DATABASE_ENV_NAMES)[number];

let sqlClient: ReturnType<typeof neon> | null = null;
let activeConnectionString: string | null = null;

function resolveDatabaseConnection(): {
  connectionString: string | null;
  variableName: DatabaseEnvName | null;
} {
  for (const variableName of DATABASE_ENV_NAMES) {
    const value = process.env[variableName]?.trim();
    if (value) {
      return { connectionString: value, variableName };
    }
  }

  return { connectionString: null, variableName: null };
}

export function getDatabaseConfig(): {
  isConfigured: boolean;
  variableName: DatabaseEnvName | null;
  acceptedVariables: readonly DatabaseEnvName[];
} {
  const { connectionString, variableName } = resolveDatabaseConnection();

  return {
    isConfigured: Boolean(connectionString),
    variableName,
    acceptedVariables: DATABASE_ENV_NAMES,
  };
}

export function getSql(): ReturnType<typeof neon> {
  const { connectionString } = resolveDatabaseConnection();

  if (!connectionString) {
    throw new Error(
      `Neon is not configured. Set one of: ${DATABASE_ENV_NAMES.join(", ")}.`,
    );
  }

  if (!sqlClient || activeConnectionString !== connectionString) {
    sqlClient = neon(connectionString);
    activeConnectionString = connectionString;
  }

  return sqlClient;
}
