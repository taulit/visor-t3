// Pairing with a T3 Code server, see docs/protocol.md §2: what the user
// pastes, what the token endpoint is sent and what it answers. Pure, so the
// settings window and the tests share it; nothing here may import the shell.
import { cleanOrigin, isInsecureOrigin } from './protocol.js';

/**
 * The servers the module is paired with: the origin each token was issued
 * for, in the order they were paired. The tokens themselves are in the
 * keyring (keyring.ts), one per origin, and each is sent to its origin only.
 */
export const SERVERS_KEY = 'servers';
/** Counts up whenever a token in the keyring changed, so the module reads them again. */
export const TOKEN_SERIAL_KEY = 'token-serial';
/**
 * The one server of the versions before several: its address (empty for the
 * local one) and the origin of its token. Read once, to carry that pairing
 * over into `servers`, and emptied then.
 */
export const LEGACY_SERVER_KEY = 'server-url';
export const LEGACY_TOKEN_ORIGIN_KEY = 'token-origin';
/** More would be a list nobody reads; each one is a socket. */
export const MAX_SERVERS = 8;

/** Reading the sessions and answering them. */
const PAIRING_SCOPES = ['orchestration:read', 'orchestration:operate'] as const;

const MAX_INPUT = 2048;
const MAX_CODE = 512;
const MAX_TOKEN = 8192;

export interface Pairing {
  /** The server the link names; null for a bare code. */
  origin: string | null;
  /** The one-time code. */
  code: string;
}

const isCode = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_CODE && /^[A-Za-z0-9._~+=-]+$/.test(value);

function tokenOf(params: string): string | null {
  for (const part of params.split('&')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at) !== 'token') continue;
    try {
      return decodeURIComponent(part.slice(at + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return null;
}

const LINK = /^(https?:\/\/[^/?#\s]*)(\/[^?#\s]*)?(?:\?([^#\s]*))?(?:#(\S*))?$/i;

/** True for a link that is refused because it names another machine over plain http. */
export function isInsecurePairing(input: unknown): boolean {
  if (typeof input !== 'string' || input.length > MAX_INPUT) return false;
  const match = LINK.exec(input.trim());
  return match !== null && isInsecureOrigin(match[1]!.replace(/^https?/i, s => s.toLowerCase()));
}

/**
 * What the user pasted: a pairing link `<origin>/pair#token=<code>` or the
 * code alone. Null for anything else: other schemes, a name and password in
 * the address, no code.
 */
export function parsePairing(input: unknown): Pairing | null {
  if (typeof input !== 'string' || input.length > MAX_INPUT) return null;
  const text = input.trim();
  if (isCode(text)) return { origin: null, code: text };

  const match = LINK.exec(text);
  if (!match) return null;
  // cleanOrigin takes a host and a port only, so `user:password@host` fails here.
  const origin = cleanOrigin(match[1]!.replace(/^https?/i, scheme => scheme.toLowerCase()));
  const code = tokenOf(match[4] ?? '') || tokenOf(match[3] ?? '') || '';
  return origin && isCode(code) ? { origin, code } : null;
}

/** The origins of `servers` that are addresses Visor sends a token to, each once, at most MAX_SERVERS. */
export function serverList(values: readonly unknown[]): string[] {
  const list: string[] = [];
  for (const value of values) {
    const origin = cleanOrigin(value);
    if (origin && !list.includes(origin) && list.length < MAX_SERVERS) list.push(origin);
  }
  return list;
}

/** The list with `origin` paired as well; a server paired again keeps its place. */
export const withServer = (list: readonly string[], origin: string): string[] =>
  serverList([...list, origin]);

export const withoutServer = (list: readonly string[], origin: string): string[] =>
  list.filter(item => item !== origin);

/** The part of Gio.Settings the carrying over needs, so that the tests need no GLib. */
interface Strings {
  get_string(key: string): string;
  set_string(key: string, value: string): boolean;
  get_strv(key: string): string[];
  set_strv(key: string, value: string[]): boolean;
}

/**
 * Carries the pairing of the versions with one server over into `servers`,
 * once: afterwards the old keys are empty. The token in the keyring is the
 * same, it is stored by origin.
 */
export function carryOverPairing(settings: Strings): void {
  const origin = settings.get_string(LEGACY_TOKEN_ORIGIN_KEY);
  if (!origin && !settings.get_string(LEGACY_SERVER_KEY)) return;
  if (origin) settings.set_strv(SERVERS_KEY, withServer(settings.get_strv(SERVERS_KEY), origin));
  settings.set_string(LEGACY_TOKEN_ORIGIN_KEY, '');
  settings.set_string(LEGACY_SERVER_KEY, '');
}

export const tokenUrl = (origin: string): string => `${origin}/oauth/token`;

/** The form-encoded body of the token exchange. */
export function tokenRequestBody(code: string, label: string): string {
  const fields: [string, string][] = [
    ['grant_type', 'urn:ietf:params:oauth:grant-type:token-exchange'],
    ['subject_token', code],
    ['subject_token_type', 'urn:t3:params:oauth:token-type:environment-bootstrap'],
    ['requested_token_type', 'urn:ietf:params:oauth:token-type:access_token'],
    ['scope', PAIRING_SCOPES.join(' ')],
    ['client_device_type', 'desktop'],
    ['client_os', 'Linux'],
  ];
  const name = label.trim().slice(0, 80);
  if (name) fields.push(['client_label', name]);
  return fields
    .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%20/g, '+')}`)
    .join('&');
}

/** The bearer token of a successful exchange that grants what Visor needs, or null. */
export function decodeAccessToken(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { access_token: token, token_type: type, scope } = value as Record<string, unknown>;
  if (typeof token !== 'string' || !token.trim() || token.length > MAX_TOKEN) return null;
  if (type !== 'Bearer') return null;
  const granted = typeof scope === 'string' ? scope.split(/\s+/) : [];
  return PAIRING_SCOPES.every(needed => granted.includes(needed)) ? token.trim() : null;
}

export type PairingError =
  | 'invalid'
  | 'insecure'
  | 'rejected'
  | 'unreachable'
  | 'incompatible'
  /** The token cannot be stored: there is no keyring or it stays locked. */
  | 'keyring'
  /** MAX_SERVERS are paired already. */
  | 'full'
  /** The command line of T3 Code made no pairing code. */
  | 'cli';

/** What an answer of the token endpoint that is not a token means. */
export const exchangeError = (status: number): PairingError =>
  status >= 400 && status < 500 ? 'rejected' : 'unreachable';

/**
 * The arguments of `t3` that make a one-time pairing code for the server of
 * this machine, for what Visor needs and no more, good for two minutes.
 */
export const cliPairingArgs = (label: string): string[] => [
  'auth',
  'pairing',
  'create',
  '--json',
  '--ttl',
  '2m',
  ...PAIRING_SCOPES.flatMap(scope => ['--scope', scope]),
  '--label',
  label.trim().slice(0, 80) || 'Visor',
];

/** The code in what `t3 auth pairing create --json` printed, or null. */
export function decodeCliPairing(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { credential } = value as Record<string, unknown>;
  return typeof credential === 'string' && isCode(credential) ? credential : null;
}
