import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openHostConfigGate } from '../../effects/host-config/gate';
import { pathRecordIsCurrent, pathRecordKey, readPathRecords } from '../../effects/host-config/path-records';

/** One fleet file as the fleet program writes it. */
export interface FleetTarget {
  readonly host: 'claude' | 'codex';
  readonly file: string;
  readonly path: string;
  readonly content: string;
}

/** `<host>-<file>.<ISO stamp with - for : and .>-<pid>.bak`, as `--force` of an older fleet named its copy. */
const BACKUP_NAME = /^(claude|codex)-(.+)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(\d+)\.bak$/;

function replacedAgentsDirectory(env: NodeJS.ProcessEnv): string {
  return join(env.HOME!, '.repo-harness', 'replaced-agents');
}

/**
 * One-shot migration (#2850): before path records, `--force` kept each user
 * fleet file that it replaced in `~/.repo-harness/replaced-agents/`. For a
 * target with a current `created` record of `core`, or with no record and the
 * fleet's bytes, the earliest copy goes to the vault and the record
 * becomes `replaced`, so a revert gives the user file back. A `replaced`
 * record is already migrated, so a second run imports nothing. The copies
 * stay where they are. A file in the directory that `--force` did not write
 * stops the migration before any change. Returns the targets it migrated.
 */
export function migrateReplacedAgents(env: NodeJS.ProcessEnv, targets: readonly FleetTarget[]): readonly { readonly path: string; readonly copy: string }[] {
  const directory = replacedAgentsDirectory(env);
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  const copies = readdirSync(directory).map((name) => {
    const match = BACKUP_NAME.exec(name);
    if (!match || !lstatSync(join(directory, name)).isFile()) {
      throw new Error(`${join(directory, name)} is not a fleet copy that rh wrote; move it out of ${directory}, then run again`);
    }
    return { path: join(directory, name), host: match[1], file: match[2], stamp: match[3]! };
  });
  const records = readPathRecords(env);
  const gate = openHostConfigGate({ env });
  const migrated: { path: string; copy: string }[] = [];
  for (const target of targets) {
    const [earliest] = copies.filter((copy) => copy.host === target.host && copy.file === target.file).sort((a, b) => a.stamp.localeCompare(b.stamp));
    if (!earliest) continue;
    const key = pathRecordKey(env, target.path);
    const record = records[key];
    // A current `created` record proves rh's file, also an older fleet version that this run refreshes next;
    // an unrecorded file must hold this fleet's bytes.
    if (record ? record.kind !== 'created' || record.owner !== 'core' || !pathRecordIsCurrent(key, record)
      : !lstatSync(target.path, { throwIfNoEntry: false })?.isFile() || readFileSync(target.path, 'utf8') !== target.content) continue;
    gate.adoptReplacedPath(target.path, 'core', readFileSync(earliest.path));
    migrated.push({ path: target.path, copy: earliest.path });
  }
  return migrated;
}
