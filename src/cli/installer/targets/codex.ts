import { migrateCodexConfigRecords } from '../codex-config-migration';
import { migrateJsonConfigRecords } from '../json-config-migration';
import { CODEX_CONFIG_FRAGMENTS, codexConfigValue, tomlFragment } from '../../../core/host-config/toml-fragment';
import type { FragmentRequest } from '../../../core/host-config/types';
import { openHostConfigGate } from '../../../effects/host-config/gate';
/**
 * Codex CLI hook-runtime target.
 *
 * Writes route-registry managed adapter entries to ~/.codex/hooks.json (Phase 0
 * verified Codex 0.130.0+ supports user-level hooks at this path; trust prompt
 * fires once per new (command, key) tuple, byte-identical re-runs hash-skip).
 *
 * Hook adapters support only the user-level global location.
 *
 * Each managed entry is a host-config fragment: the gate inserts its text and
 * a revert removes only what rh recorded, so sibling user-authored hook
 * entries on the same file keep their bytes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { requireHome } from '../../../effects/repo-harness-home';
import type {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from '../types';
import { readJsonOrEmpty } from '../shared';
import {
  applyManagedHooks,
  buildHookExecCommand,
  isManagedEntry,
  type HooksByEvent,
} from '../managed-entries';

/** Codex asks for a trust review once per new (command, key) tuple. */
const CODEX_HOOK_TRUST_STEP = 'Start interactive codex, enter /hooks, and review the hooks marked for review. Trust only the hooks you recognise.';

interface HooksFile {
  hooks?: HooksByEvent;
  [key: string]: unknown;
}

function globalConfigPath(): string {
  // Prefer $HOME env so tests can isolate via temp dirs; os.homedir() is
  // cached and ignores runtime $HOME mutations in some Node/Bun versions.
  return path.join(requireHome(), '.codex', 'hooks.json');
}

function globalTomlConfigPath(): string {
  return path.join(requireHome(), '.codex', 'config.toml');
}

const REQUEST_USER_INPUT = 'default_mode_request_user_input';
const REQUEST_USER_INPUT_LINE = `${REQUEST_USER_INPUT} = true\n`;

/**
 * The request for the root key: none when it is already `true`, `add` when it
 * is absent, and otherwise a `refresh` that the gate applies only to rh's own
 * recorded text, or an `override` with the user's explicit selection (R4).
 */
export function requestUserInputFragment(content: string, selected = false): FragmentRequest<string> | null {
  const value = codexConfigValue(content, REQUEST_USER_INPUT);
  if (value === true) return null;
  const kind = value === undefined ? 'add' : selected ? 'override' : 'refresh';
  return { owner: CODEX_CONFIG_FRAGMENTS[REQUEST_USER_INPUT], selector: REQUEST_USER_INPUT, kind, strategy: tomlFragment, value: REQUEST_USER_INPUT_LINE, selected };
}

function keptLine(value: unknown): string {
  const setting = value === undefined ? `${REQUEST_USER_INPUT} is not set` : `${REQUEST_USER_INPUT} = ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`;
  return `${setting} (your value). repo-harness skills ask plain-text numbered questions instead of request_user_input.`;
}

function ensureRequestUserInputToml(): WriteResult['files'][number] {
  const filePath = globalTomlConfigPath();
  migrateCodexConfigRecords(process.env);
  const created = !fs.existsSync(filePath);
  const current = created ? '' : fs.readFileSync(filePath, 'utf-8');
  const request = requestUserInputFragment(current);
  if (!request) return { path: filePath, action: 'unchanged' };
  const result = openHostConfigGate({ env: process.env }).apply([{ path: filePath, fragments: [request] }]);
  if (result.skipped.length) return { path: filePath, action: 'kept', detail: keptLine(codexConfigValue(current, REQUEST_USER_INPUT)) };
  if (!result.written.length) return { path: filePath, action: 'unchanged' };
  return { path: filePath, action: created ? 'created' : 'updated' };
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const filePath = globalConfigPath();
    const installed = fs.existsSync(path.dirname(filePath));
    let alreadyConfigured = false;
    if (fs.existsSync(filePath)) {
      try {
        const data = readJsonOrEmpty<HooksFile>(filePath);
        for (const entries of Object.values(data.hooks ?? {})) {
          if ((entries ?? []).some(isManagedEntry)) {
            alreadyConfigured = true;
            break;
          }
        }
      } catch {
        // Invalid JSON: surface configPath but report not-configured.
      }
    }
    return { installed, alreadyConfigured, configPath: filePath };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      throw new Error(
        'codexTarget.install: Codex has no project-local hook config; use --location global',
      );
    }
    const filePath = globalConfigPath();
    // An unresolved hook runtime stops the install before the first write.
    buildHookExecCommand(process.env);
    migrateJsonConfigRecords(process.env);
    // A config.toml that rh cannot edit stops the install before any hook write.
    const tomlResult = ensureRequestUserInputToml();
    const created = !fs.existsSync(filePath);
    const result = applyManagedHooks(filePath, 'codex');
    if (!result.written.length) return { files: [{ path: filePath, action: 'unchanged' }, tomlResult] };
    return {
      files: [{ path: filePath, action: created ? 'created' : 'updated' }, tomlResult],
      notes: [...result.refreshed, CODEX_HOOK_TRUST_STEP],
    };
  }
}

export const codexTarget: AgentTarget = new CodexTarget();
