import type { NextFunction, Request, Response } from 'express';
import {
  AGENT_DOCS_PATH,
  CANONICAL_CREATE_API_PATH,
  CREATE_NO_HEADERS_HINT,
} from './agent-guidance.js';

const REQUIRED_HEADER_VERSION = 'x-proof-client-version';
const REQUIRED_HEADER_BUILD = 'x-proof-client-build';
const REQUIRED_HEADER_PROTOCOL = 'x-proof-client-protocol';

const MIN_CLIENT_VERSION = '0.30.0';
const MIN_CLIENT_PROTOCOL = 3;
const SUPPORTED_PROTOCOLS = [3];
const UPGRADE_URL = 'https://www.proofeditor.ai/download';

function parseSemver(input: string): [number, number, number] | null {
  const match = input.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isFinite)) return null;
  return [major, minor, patch];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function parseProtocol(input: string): number | null {
  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function getHeader(req: Request, name: string): string | null {
  const value = req.header(name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasAgentOrShareCredential(req: Request): boolean {
  const shareToken = getHeader(req, 'x-share-token');
  if (shareToken) return true;

  const bridgeToken = getHeader(req, 'x-bridge-token');
  if (bridgeToken) return true;

  const authorization = getHeader(req, 'authorization');
  if (authorization && /^Bearer\s+\S+/i.test(authorization)) return true;

  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.trim()) return true;

  return false;
}

function buildUpgradePayload(reason: string, details?: Record<string, unknown>): Record<string, unknown> {
  return {
    error: 'Client upgrade required',
    code: 'CLIENT_UPGRADE_REQUIRED',
    reason,
    minVersion: MIN_CLIENT_VERSION,
    minProtocol: MIN_CLIENT_PROTOCOL,
    supportedProtocols: SUPPORTED_PROTOCOLS,
    upgradeUrl: UPGRADE_URL,
    message: `Please upgrade your Proof client to ${MIN_CLIENT_VERSION} or newer.`,
    hint: CREATE_NO_HEADERS_HINT,
    docs: AGENT_DOCS_PATH,
    createNoHeaders: { method: 'POST', href: CANONICAL_CREATE_API_PATH },
    ...details,
  };
}

function shouldEnforceApiCompatibility(pathname: string): boolean {
  if (pathname === CANONICAL_CREATE_API_PATH) return true;
  if (pathname === '/documents') return true;
  if (pathname.startsWith('/documents/')) return true;
  return false;
}

function validateClientHeaders(req: Request): { ok: true } | { ok: false; payload: Record<string, unknown> } {
  const versionHeader = getHeader(req, REQUIRED_HEADER_VERSION);
  const buildHeader = getHeader(req, REQUIRED_HEADER_BUILD);
  const protocolHeader = getHeader(req, REQUIRED_HEADER_PROTOCOL);

  if (!versionHeader || !buildHeader || !protocolHeader) {
    return {
      ok: false,
      payload: buildUpgradePayload('missing_headers', {
        missingHeaders: [
          !versionHeader ? REQUIRED_HEADER_VERSION : null,
          !buildHeader ? REQUIRED_HEADER_BUILD : null,
          !protocolHeader ? REQUIRED_HEADER_PROTOCOL : null,
        ].filter(Boolean),
      }),
    };
  }

  const parsedVersion = parseSemver(versionHeader);
  const parsedMinVersion = parseSemver(MIN_CLIENT_VERSION);
  if (!parsedVersion || !parsedMinVersion) {
    return {
      ok: false,
      payload: buildUpgradePayload('invalid_version_header', {
        providedVersion: versionHeader,
      }),
    };
  }

  const parsedProtocol = parseProtocol(protocolHeader);
  if (!parsedProtocol) {
    return {
      ok: false,
      payload: buildUpgradePayload('invalid_protocol_header', {
        providedProtocol: protocolHeader,
      }),
    };
  }

  if (!SUPPORTED_PROTOCOLS.includes(parsedProtocol) || parsedProtocol < MIN_CLIENT_PROTOCOL) {
    return {
      ok: false,
      payload: buildUpgradePayload('unsupported_protocol', {
        providedProtocol: parsedProtocol,
      }),
    };
  }

  if (compareSemver(parsedVersion, parsedMinVersion) < 0) {
    return {
      ok: false,
      payload: buildUpgradePayload('outdated_client', {
        providedVersion: versionHeader,
      }),
    };
  }

  return { ok: true };
}

function respondUpgradeRequired(res: Response, payload: Record<string, unknown>): void {
  res.status(426).json(payload);
}

export function enforceApiClientCompatibility(req: Request, res: Response, next: NextFunction): void {
  if (!shouldEnforceApiCompatibility(req.path || '/')) {
    next();
    return;
  }

  const validation = validateClientHeaders(req);
  if (!validation.ok) {
    respondUpgradeRequired(res, validation.payload);
    return;
  }
  next();
}

export function enforceBridgeClientCompatibility(req: Request, res: Response, next: NextFunction): void {
  if (hasAgentOrShareCredential(req)) {
    next();
    return;
  }

  const validation = validateClientHeaders(req);
  if (!validation.ok) {
    respondUpgradeRequired(res, validation.payload);
    return;
  }
  next();
}

export function capabilitiesPayload(): Record<string, unknown> {
  return {
    success: true,
    protocol: {
      min: MIN_CLIENT_PROTOCOL,
      supported: SUPPORTED_PROTOCOLS,
    },
    client: {
      minVersion: MIN_CLIENT_VERSION,
      requiredHeaders: [
        REQUIRED_HEADER_VERSION,
        REQUIRED_HEADER_BUILD,
        REQUIRED_HEADER_PROTOCOL,
      ],
      upgradeUrl: UPGRADE_URL,
    },
    features: {
      collabV2Only: true,
      serverNativeBridgeDefault: false,
      canonicalOpsEndpoint: true,
      publicDefaultEditorRole: true,
    },
  };
}
