/**
 * Tenant-scoped transactions against a real Postgres: explicit tenant predicates without RLS, composite
 * tenant keys, atomic commits, claims and time budgets reset between tenants.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, inject, it } from 'vite-plus/test';

import { withTenantTransaction } from '../../src/postgres/transaction.ts';

const A = 'org_1234567890abcdef';
const B = 'org_abcdef1234567890';
const options = { statementTimeoutMs: 5000, lockTimeoutMs: 1500, idleTimeoutMs: 5000 };
let owner: Pool;
let runtime: Pool;
let serialPool: Pool;
beforeAll(async () => {
  const url = new URL(inject('postgresUrl'));
  if (url.hostname !== '127.0.0.1') {
    throw new Error('Local fixture required.');
  }
  owner = new Pool({ connectionString: url.href, max: 4 });
  await owner.query(`
    CREATE ROLE fixture_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE TABLE contacts (org_id text NOT NULL, id text NOT NULL, name text, revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0), PRIMARY KEY(org_id,id)) PARTITION BY HASH(org_id);
    CREATE TABLE contacts_p0 PARTITION OF contacts FOR VALUES WITH(MODULUS 4,REMAINDER 0);
    CREATE TABLE contacts_p1 PARTITION OF contacts FOR VALUES WITH(MODULUS 4,REMAINDER 1);
    CREATE TABLE contacts_p2 PARTITION OF contacts FOR VALUES WITH(MODULUS 4,REMAINDER 2);
    CREATE TABLE contacts_p3 PARTITION OF contacts FOR VALUES WITH(MODULUS 4,REMAINDER 3);
    CREATE TABLE intents (org_id text NOT NULL, id text NOT NULL, contact_id text NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','leased','done')), PRIMARY KEY(org_id,id), FOREIGN KEY(org_id,contact_id) REFERENCES contacts(org_id,id));
    CREATE INDEX intents_due ON intents(org_id,id) WHERE state='pending';
    GRANT SELECT,INSERT,UPDATE,DELETE ON contacts,intents TO fixture_runtime;
  `);
  await owner.query('INSERT INTO contacts(org_id,id) VALUES ($1, $3),($2,$3),($1,$4)', [
    A,
    B,
    'same-id',
    'only-a',
  ]);
  url.username = 'fixture_runtime';
  runtime = new Pool({ connectionString: url.href, max: 4 });
  serialPool = new Pool({ connectionString: url.href, max: 1 });
});
afterAll(async () => {
  await runtime?.end();
  await serialPool?.end();
  await owner?.end();
});

it('isolates owner reads with explicit tenant predicates on reused pooled connections, without RLS', async () => {
  for (const organizationId of [A, B, A]) {
    const result = await withTenantTransaction(
      serialPool,
      { organizationId },
      options,
      async (db, tenant) =>
        (
          await db.query('SELECT org_id,id FROM contacts WHERE org_id=$1 ORDER BY id', [
            tenant.organizationId,
          ])
        ).rows
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.every((row) => row.org_id === organizationId)).toBe(true);
    }
  }
  const security = await owner.query("SELECT relrowsecurity FROM pg_class WHERE relname='contacts'");
  expect(security.rows[0].relrowsecurity).toBe(false);
  // No RLS is intentional: application repositories, rather than raw connection credentials, enforce tenant reads.
  expect((await runtime.query('SELECT DISTINCT org_id FROM contacts')).rows).toHaveLength(2);
});

it('enforces composite tenant foreign keys and rejects runtime DDL', async () => {
  const result = await withTenantTransaction(runtime, { organizationId: B }, options, async (db, tenant) =>
    db.query('INSERT INTO intents(org_id,id,contact_id) VALUES($1,$2,$3)', [
      tenant.organizationId,
      'foreign',
      'only-a',
    ])
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'DATABASE_CONFLICT', sqlState: '23503' } });
  await expect(runtime.query('CREATE TABLE unauthorized(id text)')).rejects.toMatchObject({ code: '42501' });
});

it('commits the owner mutation and intent atomically, and rolls both back on a crash', async () => {
  await expect(
    withTenantTransaction(runtime, { organizationId: A }, options, async (db, tenant) => {
      await db.query('INSERT INTO contacts(org_id,id) VALUES($1,$2)', [tenant.organizationId, 'crash']);
      await db.query('INSERT INTO intents(org_id,id,contact_id) VALUES($1,$2,$3)', [
        tenant.organizationId,
        'crash-intent',
        'crash',
      ]);
      throw new Error('injected before commit');
    })
  ).rejects.toThrow('injected');
  expect((await owner.query("SELECT id FROM contacts WHERE id='crash'")).rows).toHaveLength(0);
  expect((await owner.query("SELECT id FROM intents WHERE id='crash-intent'")).rows).toHaveLength(0);
  expect(
    (
      await withTenantTransaction(runtime, { organizationId: A }, options, async (db, tenant) => {
        await db.query('INSERT INTO contacts(org_id,id) VALUES($1,$2)', [tenant.organizationId, 'committed']);
        await db.query('INSERT INTO intents(org_id,id,contact_id) VALUES($1,$2,$3)', [
          tenant.organizationId,
          'commit-intent',
          'committed',
        ]);
        return null;
      })
    ).ok
  ).toBe(true);
});

it('allows only one concurrent worker to claim a due intent', async () => {
  await owner.query('INSERT INTO intents(org_id,id,contact_id) VALUES($1,$2,$3)', [B, 'claim', 'same-id']);
  const claim = () =>
    withTenantTransaction(
      runtime,
      { organizationId: B },
      options,
      async (db, tenant) =>
        (
          await db.query(
            `WITH next AS (SELECT org_id,id FROM intents WHERE org_id=$1 AND state='pending' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE intents AS work SET state='leased' FROM next WHERE work.org_id=next.org_id AND work.id=next.id RETURNING work.id`,
            [tenant.organizationId]
          )
        ).rows
    );
  const results = await Promise.all([claim(), claim(), claim()]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(results.flatMap((result) => (result.ok ? result.value : []))).toEqual([{ id: 'claim' }]);
});

it('protects a human name edit with a revision CAS across independent connections', async () => {
  await owner.query("UPDATE contacts SET name='Human',revision=revision+1 WHERE org_id=$1 AND id='same-id'", [
    A,
  ]);
  const result = await withTenantTransaction(runtime, { organizationId: A }, options, async (db, tenant) =>
    db.query(
      "UPDATE contacts SET name='Stale proposal', revision=revision+1 WHERE org_id=$1 AND id='same-id' AND revision=0 AND name IS NULL RETURNING id",
      [tenant.organizationId]
    )
  );
  expect(result.ok && result.value.rowCount).toBe(0);
  expect(
    (await owner.query("SELECT name FROM contacts WHERE org_id=$1 AND id='same-id'", [A])).rows[0].name
  ).toBe('Human');
});

it('resets transaction-local budgets before reusing the connection for another tenant', async () => {
  await withTenantTransaction(serialPool, { organizationId: A }, options, async (db) => {
    expect((await db.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('1500ms');
  });
  expect((await serialPool.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('0');
});
