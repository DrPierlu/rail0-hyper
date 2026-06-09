import { Pool } from "pg";

/**
 * Creates a pg Pool from ENVIO_PG_* variables — the same variables Envio uses,
 * so there is a single source of truth for the database connection.
 *
 *   ENVIO_PG_HOST      — hostname
 *   ENVIO_PG_PORT      — port (default: 5432)
 *   ENVIO_PG_USER      — user
 *   ENVIO_PG_PASSWORD  — password
 *   ENVIO_PG_DATABASE  — database name
 *   ENVIO_PG_SSL_MODE  — set to "require" for cloud providers (e.g. Neon)
 */
export function makePgPool(max: number): Pool {
  const host = process.env.ENVIO_PG_HOST;
  const user = process.env.ENVIO_PG_USER;
  const password = process.env.ENVIO_PG_PASSWORD;
  const database = process.env.ENVIO_PG_DATABASE;

  if (!host || !user || !password || !database) {
    throw new Error(
      "ENVIO_PG_HOST, ENVIO_PG_USER, ENVIO_PG_PASSWORD and ENVIO_PG_DATABASE must be set.",
    );
  }

  return new Pool({
    host,
    port: Number(process.env.ENVIO_PG_PORT ?? 5432),
    user,
    password,
    database,
    ssl: process.env.ENVIO_PG_SSL_MODE ? { rejectUnauthorized: false } : false,
    max,
  });
}
