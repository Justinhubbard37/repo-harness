import type { IncomingMessage, ServerResponse } from 'node:http';
import { lstatSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { OPERATOR_DEFAULT_HOST, OPERATOR_DEFAULT_MAX_CONCURRENCY, OPERATOR_DEFAULT_PORT, OPERATOR_DEFAULT_TIMEOUT_MS } from '../../core/review/operator-console-port';
import type { OperatorErrorResponseV1, OperatorServerHost } from './server';

export const OPERATOR_SERVICE_NAME = 'repo-harness-operator' as const;

export class OperatorServerError extends Error {
  constructor(
    readonly code: 'invalid_argument' | 'operator_assets_unavailable' | 'operator_server_unavailable',
    message: string,
    readonly status_code = 500,
  ) {
    super(message);
    this.name = 'OperatorServerError';
  }
}

/**
 * A Content-Security-Policy governs a document, and the only documents this
 * server serves are the static ones. JSON responses deliberately carry none:
 * they are already served `nosniff`, so a browser cannot execute them as a
 * document, and a policy attached to a non-document would be a header a reader
 * has to reason about for no boundary it protects.
 */
export const OPERATOR_STATIC_CONTENT_SECURITY_POLICY = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; img-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" as const;

export const OPERATOR_DIAGNOSTIC_ACTION = 'Retry. If the error stays, restart `rh operator serve`.';

export function assertLoopbackHost(host: string | undefined): OperatorServerHost {
  const value = host ?? OPERATOR_DEFAULT_HOST;
  if (value !== '127.0.0.1' && value !== '::1') {
    throw new OperatorServerError('invalid_argument', 'operator server host must be 127.0.0.1 or ::1', 400);
  }
  return value;
}

export function assertPort(port: number | undefined): number {
  const value = port ?? OPERATOR_DEFAULT_PORT;
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new OperatorServerError('invalid_argument', 'operator server port must be an integer from 0 through 65535', 400);
  }
  return value;
}

export function assertCollectionOption(value: number | undefined, name: string, minimum: number, maximum: number): number {
  const result = value ?? (name === 'max_concurrency'
    ? OPERATOR_DEFAULT_MAX_CONCURRENCY
    : OPERATOR_DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new OperatorServerError(
      'invalid_argument',
      `${name} must be an integer from ${minimum} through ${maximum}`,
      400,
    );
  }
  return result;
}

export function jsonHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

export function staticHeaders(contentType: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'Content-Security-Policy': OPERATOR_STATIC_CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  };
}

export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headOnly = false,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...jsonHeaders(),
    ...extraHeaders,
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  if (headOnly) response.end();
  else response.end(payload);
}

const OPERATOR_REFUSAL_PATH_MAX_CHARS = 200;

/**
 * The request target as the refusal log may state it: the path only, with the
 * query string dropped and the value JSON-quoted so a client-supplied control
 * character cannot forge a second log line.
 */
function refusalPath(request: IncomingMessage): string {
  const target = request.url ?? '/';
  const queryAt = target.indexOf('?');
  const path = queryAt < 0 ? target : target.slice(0, queryAt);
  return JSON.stringify(path.slice(0, OPERATOR_REFUSAL_PATH_MAX_CHARS));
}

/**
 * Refusals are invisible otherwise: an operator watching a board that silently
 * drops writes has nothing to look at. The line carries the decision and
 * nothing that could leak the request — no body, no headers, and in particular
 * no Origin, since the refused Origin is exactly the attacker-controlled string
 * a log reader would then be tempted to trust. stdout stays the single bound
 * URL line the CLI contract prints.
 */
export function sendRefusal(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: OperatorErrorResponseV1,
  headOnly = false,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  process.stderr.write(
    `${OPERATOR_SERVICE_NAME} refused method=${request.method ?? 'GET'} status=${status} code=${body.error.code} path=${refusalPath(request)}\n`,
  );
  sendJson(response, status, body, headOnly, extraHeaders);
}

export function errorBody(
  code: string,
  message: string,
  nextAction: string = OPERATOR_DIAGNOSTIC_ACTION,
): OperatorErrorResponseV1 {
  return Object.freeze({
    error: Object.freeze({ code, message, next_action: nextAction }),
  });
}

export function contentType(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}

export function fileIfSafe(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (_error) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  if (relative.length === 0 || isAbsolute(relative) || relative.split('/').includes('..')) return null;
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) return null;
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return candidate;
  } catch (_error) {
    return null;
  }
}

export function fallbackIndex(root: string): string | null {
  return fileIfSafe(root, '/');
}

export function isHtmlNavigation(request: IncomingMessage, pathname: string): boolean {
  if (pathname === '/') return true;
  if (extname(pathname) !== '') return false;
  const accept = request.headers.accept ?? '';
  return accept.includes('text/html');
}

export function expectedRequestAuthority(host: OperatorServerHost, request: IncomingMessage): string | null {
  const localPort = request.socket.localPort;
  if (!Number.isSafeInteger(localPort)) return null;
  const authorityHost = host === '::1' ? `[${host}]` : host;
  return `${authorityHost}:${localPort}`;
}

/** HTTP status for an architecture read failure code. */
export function architectureStatus(code: string): number {
  return code === 'timeout' ? 504 : code.endsWith('_not_found') ? 404 : code === 'invalid_request' || code === 'shard_out_of_range' ? 400
    : code === 'worktree_changed_during_read' ? 409 : code === 'unavailable' || code === 'busy' ? 503 : 422;
}
