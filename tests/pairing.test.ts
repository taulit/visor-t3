import { describe, expect, it } from 'vitest';
import {
  tokenFits,
  isInsecurePairing,
  DEFAULT_ORIGIN,
  decodeAccessToken,
  exchangeError,
  originToStore,
  parsePairing,
  tokenRequestBody,
  tokenUrl,
} from '../src/pairing.js';

describe('parsePairing', () => {
  it('takes a full pairing link', () => {
    expect(parsePairing('http://127.0.0.1:3773/pair#token=abc-DEF_123')).toEqual({
      origin: 'http://127.0.0.1:3773',
      code: 'abc-DEF_123',
    });
  });

  it('takes a link with another origin, https and IPv6', () => {
    expect(parsePairing('https://t3.example.org/pair#token=k9')).toEqual({
      origin: 'https://t3.example.org',
      code: 'k9',
    });
    expect(parsePairing('HTTP://[::1]:8080/pair#token=k9')?.origin).toBe('http://[::1]:8080');
  });

  it('finds the token in the query as the mobile app does, and decodes it', () => {
    expect(parsePairing('http://localhost:1/pair?token=a%2Bb')?.code).toBe('a+b');
    expect(parsePairing('http://localhost:1/?x=1#y=2&token=zz')?.code).toBe('zz');
  });

  it('refuses plain http to another machine and says so', () => {
    expect(parsePairing('http://t3.example.org/pair#token=k9')).toBeNull();
    expect(parsePairing('http://192.168.1.5:3773/pair#token=k9')).toBeNull();
    expect(isInsecurePairing('http://t3.example.org/pair#token=k9')).toBe(true);
    expect(isInsecurePairing('HTTP://192.168.1.5:3773/pair#token=k9')).toBe(true);
    expect(isInsecurePairing('https://t3.example.org/pair#token=k9')).toBe(false);
    expect(isInsecurePairing('http://127.0.0.1:3773/pair#token=k9')).toBe(false);
    expect(isInsecurePairing('k9')).toBe(false);
    expect(isInsecurePairing(null)).toBe(false);
  });

  it('takes a bare code', () => {
    expect(parsePairing('AbC123-xyz')).toEqual({ origin: null, code: 'AbC123-xyz' });
  });

  it('ignores whitespace around the input', () => {
    expect(parsePairing('  \n http://localhost:3773/pair#token=abc \t')).toEqual({
      origin: 'http://localhost:3773',
      code: 'abc',
    });
    expect(parsePairing('  abc\n')?.code).toBe('abc');
  });

  it('rejects other schemes', () => {
    for (const link of [
      't3code://pair#token=abc',
      'ftp://host/pair#token=abc',
      'file:///pair#token=abc',
      'javascript:alert(1)',
      'ws://host/pair#token=abc',
    ])
      expect(parsePairing(link)).toBeNull();
  });

  it('rejects a name or password in the address', () => {
    expect(parsePairing('http://user:secret@localhost:3773/pair#token=abc')).toBeNull();
    expect(parsePairing('https://user@host/pair#token=abc')).toBeNull();
  });

  it('rejects garbage', () => {
    for (const input of [
      '',
      '   ',
      'two words',
      'http://',
      'http://localhost:3773/pair',
      'http://localhost:3773/pair#token=',
      'http://localhost:3773/pair#token=a b',
      'http://localhost:3773/pair#token=%E0%A4%A',
      'http://ho st/pair#token=abc',
      'http://localhost:3773/pair#token=<script>',
      'x'.repeat(3000),
      null,
      42,
    ])
      expect(parsePairing(input)).toBeNull();
  });
});

describe('originToStore', () => {
  it('stores nothing for the local server', () => {
    expect(originToStore(DEFAULT_ORIGIN, null)).toBe('');
    expect(originToStore('http://127.0.0.1:4000', 'http://127.0.0.1:4000')).toBe('');
  });

  it('stores any other origin', () => {
    expect(originToStore('https://t3.example.org', null)).toBe('https://t3.example.org');
    expect(originToStore(DEFAULT_ORIGIN, 'http://127.0.0.1:4000')).toBe(DEFAULT_ORIGIN);
  });
});

describe('tokenFits', () => {
  it('sends a token only to the origin it was issued for', () => {
    expect(tokenFits('http://127.0.0.1:3773', 'http://127.0.0.1:3773')).toBe(true);
    expect(tokenFits('http://127.0.0.1:3773', 'http://127.0.0.1:3774')).toBe(false);
    expect(tokenFits('http://127.0.0.1:3773', 'https://127.0.0.1:3773')).toBe(false);
    expect(tokenFits('https://t3.example.org', 'https://evil.example.org')).toBe(false);
    // A token from before the origin was stored goes nowhere.
    expect(tokenFits('', 'http://127.0.0.1:3773')).toBe(false);
    expect(tokenFits('', '')).toBe(false);
    expect(tokenFits('http://127.0.0.1:3773', null)).toBe(false);
  });
});

describe('the token exchange', () => {
  it('addresses the token endpoint', () => {
    expect(tokenUrl('http://127.0.0.1:3773')).toBe('http://127.0.0.1:3773/oauth/token');
  });

  it('sends the form of docs/protocol.md', () => {
    const form = new URLSearchParams(tokenRequestBody('a+b c', '  Visor on déjà  '));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'a+b c',
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'orchestration:read orchestration:operate',
      client_device_type: 'desktop',
      client_os: 'Linux',
      client_label: 'Visor on déjà',
    });
    expect(tokenRequestBody('abc', ' ')).not.toContain('client_label');
  });

  it('reads the token of an answer that grants both scopes', () => {
    const answer = { access_token: 'tok', token_type: 'Bearer', expires_in: 60 };
    expect(
      decodeAccessToken(
        JSON.stringify({ ...answer, scope: 'orchestration:operate orchestration:read x' }),
      ),
    ).toBe('tok');
    expect(
      decodeAccessToken(JSON.stringify({ ...answer, scope: 'orchestration:read' })),
    ).toBeNull();
    expect(decodeAccessToken(JSON.stringify(answer))).toBeNull();
    expect(
      decodeAccessToken(
        JSON.stringify({
          ...answer,
          token_type: 'DPoP',
          scope: 'orchestration:read orchestration:operate',
        }),
      ),
    ).toBeNull();
    for (const text of ['', 'null', '[]', '{"access_token":""}', '{"access_token":7}'])
      expect(decodeAccessToken(text)).toBeNull();
  });

  it('tells a refused code from a server that is not there', () => {
    expect(exchangeError(400)).toBe('rejected');
    expect(exchangeError(401)).toBe('rejected');
    expect(exchangeError(500)).toBe('unreachable');
    expect(exchangeError(0)).toBe('unreachable');
  });
});
