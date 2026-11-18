# Key management (field encryption)

Owner: Agent D. Code: `apps/api/src/security/field-crypto.service.ts`, CLI `apps/api/src/security/cli/rotate-keys.ts`.

## What is encrypted

Every `*_enc bytea` column in schema `app`: guardian and staff Ghana Card numbers, SSNIT numbers, the four medical text fields in `student_medical`, and users' MFA secrets. Format: AES-256-GCM envelope, a fresh 256-bit data key per value, wrapped by a master key; byte 1 of the value is the master key id. Ghana Card lookups use an HMAC-SHA256 blind index (`*_bidx`) with a separate key that does not change when master keys rotate.

## The master key file

`SMS_MASTER_KEY_FILE` points to a text file, mounted as a Docker secret, owned by the container user, mode `0400` (the API refuses to start in production if group or others can read it):

```
# id:base64(32 random bytes)   the highest id encrypts new values
1:3q2+7w...=
bidx:Zm9v...=
```

Create it once at installation:

```bash
node dist/security/cli/rotate-keys.js generate        > master.key   # writes "1:..."
node dist/security/cli/rotate-keys.js generate --bidx >> master.key
chmod 400 master.key
```

**Keep two offline copies** (printed or on an encrypted USB stick) in sealed envelopes: one in the school safe, one with the proprietor. The key file is **not** in the database backups on purpose. Without it, encrypted fields in a restored backup cannot be read.

## Rotation (yearly, after staff with server access leave, or after a suspected leak)

1. Append a new key: `SMS_MASTER_KEY_FILE=/run/secrets/master.key node dist/security/cli/rotate-keys.js generate >> master.key` (gives the next id).
2. Restart `api` and `worker` so new values use the new key (old values still decrypt).
3. Re-wrap existing values: `node dist/security/cli/rotate-keys.js rotate --dry-run`, then `rotate`. It works in batches, can be stopped and re-run.
4. Check: `rotate --check` must show only the new key id for every column.
5. Take a fresh backup; update the offline copies.
6. Optional: remove the old key line once no backup that still needs it is kept (12 months with the default backup retention).

Never remove or change the `bidx:` line: blind indexes depend on it. Never reuse a key id.

## CSRF secret

The CSRF token key is derived from the blind-index key (or read from `SMS_SESSION_SECRET_FILE` when set), so CSRF tokens survive restarts and master-key rotation.
