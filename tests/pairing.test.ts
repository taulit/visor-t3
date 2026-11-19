import { describe, expect, it } from 'vitest';
import {
  LEGACY_SERVER_KEY,
  LEGACY_TOKEN_ORIGIN_KEY,
  MAX_SERVERS,
  SERVERS_KEY,
  carryOverPairing,
  cliPairingArgs,
  decodeAccessToken,
  decodeCliPairing,
  exchangeError,
  isInsecurePairing,
  parsePairing,
  serverList,
  tokenRequestBody,
  tokenUrl,
  withServer,
  withoutServer,
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
    expect(isInsecurePairing('http://100.87.29.32:3773/pair#token=k9')).toBe(false);
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

describe('the list of servers', () => {
  it('keeps addresses a token may go to, each once, in order', () => {
    expect(
      serverList([
        'http://127.0.0.1:3773/',
        'http://100.87.29.32:3773',
        'http://127.0.0.1:3773',
        'http://192.168.1.5:3773',
        'not an address',
        42,
        'https://t3.example.org',
      ]),
    ).toEqual(['http://127.0.0.1:3773', 'http://100.87.29.32:3773', 'https://t3.example.org']);
  });

  it('takes at most MAX_SERVERS', () => {
    const many = Array.from({ length: MAX_SERVERS + 3 }, (_, i) => `http://127.0.0.1:${4000 + i}`);
    expect(serverList(many)).toHaveLength(MAX_SERVERS);
  });

  it('adds a server last and a known one not again, and removes one', () => {
    const list = ['http://127.0.0.1:3773'];
    expect(withServer(list, 'http://100.87.29.32:3773')).toEqual([
      'http://127.0.0.1:3773',
      'http://100.87.29.32:3773',
    ]);
    expect(withServer(list, 'http://127.0.0.1:3773')).toEqual(list);
    expect(withServer(list, 'http://192.168.1.5:3773')).toEqual(list);
    expect(withoutServer(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
});

describe('carrying the pairing of one server over', () => {
  const settings = (values: Record<string, string | string[]>) => ({
    values,
    get_string: (key: string) => values[key] as string,
    set_string: (key: string, value: string) => ((values[key] = value), true),
    get_strv: (key: string) => values[key] as string[],
    set_strv: (key: string, value: string[]) => ((values[key] = value), true),
  });

  it('moves the paired origin into the list and empties the old keys', () => {
    const local = settings({
      [SERVERS_KEY]: [],
      [LEGACY_SERVER_KEY]: '',
      [LEGACY_TOKEN_ORIGIN_KEY]: 'http://127.0.0.1:3773',
    });
    carryOverPairing(local);
    expect(local.values).toEqual({
      [SERVERS_KEY]: ['http://127.0.0.1:3773'],
      [LEGACY_SERVER_KEY]: '',
      [LEGACY_TOKEN_ORIGIN_KEY]: '',
    });
    const remote = settings({
      [SERVERS_KEY]: ['http://127.0.0.1:3773'],
      [LEGACY_SERVER_KEY]: 'https://t3.example.org',
      [LEGACY_TOKEN_ORIGIN_KEY]: 'https://t3.example.org',
    });
    carryOverPairing(remote);
    expect(remote.values[SERVERS_KEY]).toEqual(['http://127.0.0.1:3773', 'https://t3.example.org']);
  });

  it('drops an address nothing was paired with, and does nothing a second time', () => {
    const address = settings({
      [SERVERS_KEY]: [],
      [LEGACY_SERVER_KEY]: 'https://t3.example.org',
      [LEGACY_TOKEN_ORIGIN_KEY]: '',
    });
    carryOverPairing(address);
    expect(address.values).toEqual({
      [SERVERS_KEY]: [],
      [LEGACY_SERVER_KEY]: '',
      [LEGACY_TOKEN_ORIGIN_KEY]: '',
    });
    const done = settings({
      [SERVERS_KEY]: ['http://127.0.0.1:3773'],
      [LEGACY_SERVER_KEY]: '',
      [LEGACY_TOKEN_ORIGIN_KEY]: '',
    });
    carryOverPairing(done);
    expect(done.values[SERVERS_KEY]).toEqual(['http://127.0.0.1:3773']);
  });
});

describe('the command line of T3 Code', () => {
  it('asks for a short-lived code with the two scopes Visor needs', () => {
    expect(cliPairingArgs('Visor (anton)')).toEqual([
      'auth',
      'pairing',
      'create',
      '--json',
      '--ttl',
      '2m',
      '--scope',
      'orchestration:read',
      '--scope',
      'orchestration:operate',
      '--label',
      'Visor (anton)',
    ]);
  });

  it('reads the code of its answer', () => {
    const answer = {
      id: 'd34cb2b6-0355-4ad0-b024-0d77599c2647',
      credential: 'EU76KMRC2QHF',
      label: 'Visor (anton)',
      scopes: ['orchestration:read', 'orchestration:operate'],
      expiresAt: '2026-11-19T10:31:35.108Z',
      pairUrl: 'http://127.0.0.1:3773/pair#token=EU76KMRC2QHF',
    };
    expect(decodeCliPairing(JSON.stringify(answer))).toBe('EU76KMRC2QHF');
    expect(decodeCliPairing('Issued pairing credential')).toBeNull();
    expect(decodeCliPairing('{"credential":"has spaces"}')).toBeNull();
    expect(decodeCliPairing('{"credential":42}')).toBeNull();
    expect(decodeCliPairing('null')).toBeNull();
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
