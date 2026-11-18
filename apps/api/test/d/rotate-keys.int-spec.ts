import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { FieldCryptoEngine, generateKeyLine, parseKeyFile } from '../../src/security/field-crypto.service';
import { discoverEncryptedColumns, keyUsage, rotateAll } from '../../src/security/cli/rotate-keys';

let tdb: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  tdb = await createTestDatabase('d_keys');
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
});
afterAll(async () => {
  await client?.end();
  await tdb?.drop();
});

describe('key rotation CLI', () => {
  it('finds all encrypted columns, re-wraps them to the new key, and old key can then be retired', async () => {
    const cols = (await discoverEncryptedColumns(client)).map((c) => `${c.table}.${c.column}`);
    expect(cols).toEqual(expect.arrayContaining(['guardians.ghana_card_enc', 'student_medical.allergies_enc', 'users.mfa_secret_enc', 'staff.ssnit_no_enc']));

    const k1 = generateKeyLine(1);
    const k2 = generateKeyLine(2);
    const bidx = generateKeyLine('bidx');
    const old = new FieldCryptoEngine(parseKeyFile(`${k1}\n${bidx}`));
    for (let i = 0; i < 3; i++) {
      await client.query(`INSERT INTO app.guardians (first_name, last_name, phone_primary, ghana_card_enc) VALUES ('Kofi', 'Owusu', $1, $2)`,
        [`+23324000010${i}`, old.encrypt(`GHA-00000000${i}-${i}`)]);
    }
    expect((await keyUsage(client))['guardians.ghana_card_enc']).toEqual({ 1: 3 });

    const rotated = new FieldCryptoEngine(parseKeyFile(`${k1}\n${k2}\n${bidx}`));
    expect(await rotateAll(client, rotated, { dryRun: true })).toBe(3);
    expect(await rotateAll(client, rotated, { batch: 2 })).toBe(3);
    expect((await keyUsage(client))['guardians.ghana_card_enc']).toEqual({ 2: 3 });
    expect(await rotateAll(client, rotated)).toBe(0); // idempotent

    const retired = new FieldCryptoEngine(parseKeyFile(`${k2}\n${bidx}`));
    const rows = await client.query<{ ghana_card_enc: Buffer }>('SELECT ghana_card_enc FROM app.guardians ORDER BY phone_primary');
    expect(rows.rows.map((r) => retired.decrypt(r.ghana_card_enc))).toEqual(['GHA-000000000-0', 'GHA-000000001-1', 'GHA-000000002-2']);
  });
});
