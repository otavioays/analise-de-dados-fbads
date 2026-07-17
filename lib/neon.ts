import { neon } from "@neondatabase/serverless";

let sqlClient: ReturnType<typeof neon> | null = null;

export function getSql(): ReturnType<typeof neon> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("Neon is not configured. Set DATABASE_URL.");
  }

  if (!sqlClient) {
    sqlClient = neon(connectionString);
  }

  return sqlClient;
}
