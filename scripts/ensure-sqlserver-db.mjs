#!/usr/bin/env node
/**
 * Creates the conformance database on a SQL Server that has none.
 *
 * The SQL Server image starts with only the system databases, and the conformance suite will not
 * create one for itself — provisioning its own schema inside a database somebody else made is as
 * far as it goes, so that pointing it at a real server can never mean "and make yourself a
 * database here".
 *
 * This used to shell out to `mcr.microsoft.com/mssql-tools18`, which does not exist: the image is
 * published without a `latest` tag and the hosted run failed pulling it. Using the `mssql` driver
 * the product already depends on removes the image entirely, and has the useful side effect of
 * proving the driver can reach the server before the suite starts.
 *
 * Usage: node scripts/ensure-sqlserver-db.mjs <connection-url> [database]
 */

import sql from 'mssql';

const [, , rawUrl, explicitName] = process.argv;
if (!rawUrl) {
  console.error('usage: ensure-sqlserver-db.mjs sqlserver://user:pass@host:port/database');
  process.exit(2);
}

const url = new URL(rawUrl);
const database = explicitName ?? decodeURIComponent(url.pathname.replace(/^\//, ''));
if (!database) {
  console.error('error: no database named in the connection url');
  process.exit(2);
}

// Connect to `master`, because the database being created does not exist yet.
const pool = new sql.ConnectionPool({
  server: url.hostname,
  port: Number(url.port) || 1433,
  database: 'master',
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 30_000,
});

try {
  await pool.connect();
  // The name comes from our own workflow rather than from user input, and is still bound as a
  // parameter into a dynamic statement rather than concatenated — a habit worth keeping even where
  // the input is trusted, because the next person to copy this may not check.
  await pool
    .request()
    .input('name', sql.NVarChar(128), database)
    .query(
      `IF DB_ID(@name) IS NULL
         BEGIN
           DECLARE @sql nvarchar(300) = N'CREATE DATABASE ' + QUOTENAME(@name);
           EXEC sp_executesql @sql;
         END`,
    );
  const check = await pool
    .request()
    .input('name', sql.NVarChar(128), database)
    .query('SELECT DB_ID(@name) AS id');
  if (check.recordset[0]?.id == null) throw new Error(`${database} was not created`);
  console.warn(`SQL Server database "${database}" is present.`);
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool.close().catch(() => undefined);
}
