import { config as dotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv({ path: path.join(__dirname, '..', '.env') });

// Prefer the SSH tunnel (local port) when it is up; fall back to DATABASE_URL.
const useTunnel = process.env.PGHOST === '127.0.0.1' || process.env.PGHOST === 'localhost';
const cfg = useTunnel
  ? {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
    }
  : { connectionString: process.env.DATABASE_URL };

const client = new pg.Client(cfg);
await client.connect();
try {
  await client.query('ALTER TABLE bank_audit_entries ADD COLUMN IF NOT EXISTS pre_claim_status text');
  const { rows } = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name='bank_audit_entries' AND column_name='pre_claim_status'");
  console.log(rows.length ? 'pre_claim_status column present' : 'FAILED');
} finally {
  await client.end();
}
