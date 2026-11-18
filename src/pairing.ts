// Pairing with a T3 Code server, see docs/protocol.md §2: what the user
// pastes, what the token endpoint is sent and what it answers. Pure, so the
// settings window and the tests share it; nothing here may import the shell.
import { cleanOrigin, isInsecureOrigin } from './protocol.js';

/** The settings the module reads and the settings window writes. */
export const SERVER_KEY = 'server-url';
/**
 * The origin the token was issued for, empty when not paired. The token
 * itself is in the keyring (keyring.ts) and is sent nowhere else.
 */
export const TOKEN_ORIGIN_KEY = 'token-origin';
/** Counts up whenever the token in the keyring changed, so the module reads it again. */
export const TOKEN_SERIAL_KEY = 'token-serial';

/** Where a server listens when nothing says otherwise. */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:3773';
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

/** What `t3-server-url` is set to after pairing: empty when the server is the local one. */
export const originToStore = (origin: string, local: string | null): string =>
  origin === (local ?? DEFAULT_ORIGIN) ? '' : origin;

/** True when a token issued for `tokenOrigin` may be sent to `origin`: only to that very origin. */
export const tokenFits = (tokenOrigin: string, origin: string | null): boolean =>
  origin !== null && origin !== '' && tokenOrigin === origin;

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
  | 'keyring';

/** What an answer of the token endpoint that is not a token means. */
export const exchangeError = (status: number): PairingError =>
  status >= 400 && status < 500 ? 'rejected' : 'unreachable';
