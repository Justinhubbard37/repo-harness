import type { HostConfigBackupPolicy } from './types';

/**
 * Owner decisions on #2848 (2026-11-17). Claude Code rewrites `~/.claude.json`
 * itself and the file can hold a login key, so rh's add there keeps no
 * whole-file copy in the vault; a selected override still takes one.
 */
export const CLAUDE_ROOT_CONFIG_BACKUP: HostConfigBackupPolicy = 'overrides-only';

/** The CodeGraph tool rule is a `permissions.allow` entry; rh no longer writes the top-level `allowedTools` key. */
export const CODEGRAPH_PERMISSION_SELECTOR = 'permissions.allow[mcp__codegraph__*]';
export const CODEGRAPH_PERMISSION_RULE = 'mcp__codegraph__*';
/** The top-level `allowedTools` entry that earlier rh versions wrote; configure takes it out while it is intact. */
export const LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR = 'allowedTools[mcp__codegraph__*]';
export const CODEGRAPH_MCP_SELECTOR = 'mcpServers.codegraph';

/** One owner per JSON fragment (#2841). */
export function claudeFragmentOwner(selector: string): 'core' | 'architecture' {
  return selector.startsWith('hooks.') || selector === 'statusLine' ? 'core' : 'architecture';
}
