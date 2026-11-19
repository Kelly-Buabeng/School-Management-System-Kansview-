import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './trust-proxy';

describe('parseTrustProxy (CP5-02)', () => {
  it('trusts nobody by default', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
  });
  it('accepts a hop count and address / subnet lists', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('172.18.0.0/16, loopback')).toEqual(['172.18.0.0/16', 'loopback']);
    expect(parseTrustProxy('fd00::/8')).toEqual(['fd00::/8']);
  });
  it('refuses "true" and anything that is not an address', () => {
    expect(() => parseTrustProxy('true')).toThrow(/any client/);
    expect(() => parseTrustProxy('caddy')).toThrow(/not an IP address/);
    expect(() => parseTrustProxy('10.0.0.0/33')).toThrow();
    expect(() => parseTrustProxy('99')).toThrow();
  });
});
