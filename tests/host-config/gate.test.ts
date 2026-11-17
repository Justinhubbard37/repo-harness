import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FragmentEdit, HostConfigStrategy, HostPath } from '../../src/core/host-config/types';
import { openHostConfigGate, type HostConfigFileChange } from '../../src/effects/host-config/gate';
import { hostConfigPaths, migrateLedgerSchema, replaceTarget } from '../../src/effects/host-config/store';
import { jsonFragment } from '../../src/core/host-config/json-fragment';

/** A `key=value` line format: the selector is the key. */
function keyLineMatch(content: string, selector: string): RegExpExecArray | null {
  return new RegExp(`^${selector.replace(/\./g, '\\.')}=.*\\n`, 'm').exec(content);
}
function keyLineEdit(content: string, selector: string, value: string): FragmentEdit {
  const match = keyLineMatch(content, selector);
  const inserted = `${selector}=${value}\n`;
  return match ? { at: match.index, removed: match[0], inserted } : { at: content.length, removed: '', inserted };
}
const keyLine: HostConfigStrategy<string> = {
  locate: (content, selector) => { const match = keyLineMatch(content, selector); return match ? { start: match.index, end: match.index + match[0].length } : null; },
  apply: keyLineEdit,
};

/** The same format with an edit of the value only: the inserted text does not name its selector. */
const valueOnly: HostConfigStrategy<string> = {
  locate: () => null,
  apply: (content, selector, value) => {
    const match = new RegExp(`^${selector}=(.*)$`, 'm').exec(content)!;
    return { at: match.index + selector.length + 1, removed: match[1]!, inserted: value };
  },
};

/** The whole `key=...` line is the value: '' deletes the line, and a missing key appends it. */
const wholeLine: HostConfigStrategy<string> = { locate: () => null, apply: (content, selector, value) => ({ ...keyLineEdit(content, selector, ''), inserted: value }) };

/** Replaces the first occurrence of the selector's own text: value '' deletes it. */
const ownText: HostConfigStrategy<string> = { locate: () => null, apply: (content, selector, value) => ({ at: content.indexOf(selector), removed: selector, inserted: value }) };

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test('an install-owned whole path refuses every gate operation and stays in the ledger; a protocol 1 ledger names rh update', () => {
  const f = fixture();
  const skill = join(f.home, '.claude', 'skills', 'owned');
  const inside = join(skill, 'SKILL.md');
  mkdirSync(skill, { recursive: true });
  writeFileSync(inside, 'rh=user\n');
  f.gate().apply([f.change(f.a, 'on')]);
  const paths = { [skill]: { owner: 'core', host: 'claude', kind: 'created', baseline: { state: 'unknown' }, committed: { type: 'directory', sha256: `sha256:${'0'.repeat(64)}` } } };
  writeFileSync(join(f.root, 'ledger.json'), JSON.stringify({ ...f.ledger(), paths }));
  const operations = [
    () => f.gate().apply([f.change(inside, 'on')]),
    () => f.gate().delegate([inside], () => writeFileSync(inside, 'rh=delegate\n')),
    () => f.gate().adopt(inside, { backup: null, fragments: [], externalChange: false }),
    () => f.gate().revert([inside]),
  ];
  for (const operation of operations) expect(operation).toThrow(`an install owns this whole path (${skill})`);
  expect(readFileSync(inside, 'utf8')).toBe('rh=user\n');
  // A write elsewhere keeps the path records.
  f.gate().apply([f.change(f.b, 'on')]);
  expect(f.ledger().paths).toEqual(paths);

  const { paths: _paths, ...textRecords } = f.ledger();
  writeFileSync(join(f.root, 'ledger.json'), JSON.stringify({ ...textRecords, protocol: 1 }));
  expect(() => f.gate().recorded(f.a)).toThrow('the ledger is protocol 1, which has no path records; run: rh update');
  // The one-shot move keeps every text record and starts `paths` empty; a second run writes nothing.
  migrateLedgerSchema(hostConfigPaths({ HOME: f.home }));
  expect(f.ledger()).toEqual({ ...textRecords, protocol: 2, paths: {} });
  const moved = readFileSync(join(f.root, 'ledger.json'));
  migrateLedgerSchema(hostConfigPaths({ HOME: f.home }));
  expect(readFileSync(join(f.root, 'ledger.json'))).toEqual(moved);
});

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rh-host-config-')));
  homes.push(home);
  const a = join(home, '.alpha.conf');
  const b = join(home, '.tool', 'sub', 'b.conf');
  writeFileSync(a, 'keep=1\n');
  chmodSync(a, 0o640);
  const root = join(home, '.repo-harness', 'config');
  const gate = () => openHostConfigGate({ env: { HOME: home } });
  const change = (path: string, value: string, extra: Partial<HostConfigFileChange['fragments'][number]> = {}): HostConfigFileChange =>
    ({ path, fragments: [{ owner: 'o1', selector: 'rh', kind: 'add', strategy: keyLine, value, ...extra }] });
  const ledger = () => JSON.parse(readFileSync(join(root, 'ledger.json'), 'utf8'));
  const vault = (reference: unknown) => readFileSync(join(root, 'vault', String(reference).replace('sha256:', '')), 'utf8');
  /** Selected overrides in `a`, one per selector. */
  const select = (strategy: HostConfigStrategy<string>, values: Record<string, string>) => gate().apply([{ path: a, fragments: Object.entries(values)
    .map(([selector, value]) => ({ owner: 'o1', selector, kind: 'override' as const, strategy, value, selected: true })) }]);
  return { home, a, b, root, gate, change, ledger, vault, select };
}

test('every write has a ledger record before a revert, and a revert touches no path without one', () => {
  const f = fixture();
  const c = join(f.home, '.charlie.conf');
  const b2 = join(f.home, '.tool', 'sub', 'b2.conf');
  writeFileSync(c, 'rh=user\n');
  expect(f.gate().apply([f.change(f.a, 'on'), f.change(f.b, 'on'), f.change(b2, 'on')]).written).toEqual([f.a, f.b, b2]);
  const files = f.ledger().files;
  expect({ a: files[f.a].kind, b: files[f.b].kind, dirs: f.ledger().directories, c: files[c] })
    .toEqual({ a: 'text_block', b: 'created', dirs: [join(f.home, '.tool'), join(f.home, '.tool', 'sub')], c: undefined });
  // b and b2 share the created directories: they go after both files.
  expect(f.gate().revert().map((entry) => [entry.path, entry.action])).toEqual([[f.a, 'text_removed'], [f.b, 'removed'], [b2, 'removed']]);
  expect({ a: readFileSync(f.a, 'utf8'), mode: statSync(f.a).mode & 0o777, tool: existsSync(join(f.home, '.tool')), c: readFileSync(c, 'utf8') })
    .toEqual({ a: 'keep=1\n', mode: 0o640, tool: false, c: 'rh=user\n' });
  expect(f.ledger()).toEqual({ protocol: 2, files: {}, fragments: [], directories: [], paths: {} });

  // The record is in the ledger before the writer runs, and a failed ledger write stops the file write.
  let seen: unknown;
  f.gate().delegate([c], () => { seen = f.ledger().files[c]?.kind; });
  expect(seen).toBe('replaced');
  chmodSync(f.root, 0o500);
  try { expect(() => f.gate().apply([f.change(f.a, 'on')])).toThrow(expect.objectContaining({ code: 'EACCES' })); }
  finally { chmodSync(f.root, 0o700); }
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
});

test('rh backs up user bytes before it replaces them, and a revert restores the backup', () => {
  const f = fixture();
  // A delegated writer replaces a user file: the old bytes go to the vault first.
  f.gate().delegate([f.a], ([destination]) => writeFileSync(destination!, 'external\n'));
  const { kind, backup } = f.ledger().files[f.a];
  expect({ kind, vault: f.vault(backup) }).toEqual({ kind: 'replaced', vault: 'keep=1\n' });
  expect(f.gate().revert([f.a]).map((entry) => entry.action)).toEqual(['restored']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');

  // An explicit override backs up the whole user file, a refresh keeps that backup, and a revert puts it back.
  const skipped = f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override' })]);
  expect(skipped).toEqual({ written: [], skipped: [{ code: 'host_config_override_skipped', file: f.a, owner: 'o1', selector: 'keep' }] });
  f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override', selected: true })]);
  const overrideBackup = f.ledger().files[f.a].backup;
  expect(f.vault(overrideBackup)).toBe('keep=1\n');
  f.gate().apply([f.change(f.a, 'y', { selector: 'keep', kind: 'refresh', selected: true })]);
  expect(f.ledger().files[f.a].backup).toBe(overrideBackup);
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['text_removed']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
  for (const entry of [f.root, join(f.root, 'vault')]) expect(statSync(entry).mode & 0o777).toBe(0o700);
});

test('a revert keeps and reports a file whose rh bytes the user edited', () => {
  const f = fixture();
  f.gate().apply([f.change(f.a, 'on'), f.change(f.b, 'on')]);
  writeFileSync(f.a, 'keep=1\nrh=user\n');
  writeFileSync(f.b, 'rh=on\nmine=1\n');
  expect(f.gate().revert().map((entry) => [entry.path, entry.action])).toEqual([[f.a, 'kept_edited'], [f.b, 'kept_edited']]);
  expect({ a: readFileSync(f.a, 'utf8'), b: readFileSync(f.b, 'utf8') }).toEqual({ a: 'keep=1\nrh=user\n', b: 'rh=on\nmine=1\n' });
  expect(Object.keys(f.ledger().files)).toEqual([f.a, f.b]);
  // The write itself re-reads the target: bytes that rh did not see are never overwritten.
  expect(() => replaceTarget(f.a as HostPath, Buffer.from('rh\n'), { existed: true, sha256: `sha256:${'0'.repeat(64)}` }))
    .toThrow(expect.objectContaining({ code: 'host_config_target_changed' }));
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\nrh=user\n');
});

test('an edit since rh last wrote a file is a sticky external change, also when rh writes nothing now', () => {
  const f = fixture();
  f.gate().apply([f.change(f.a, 'on')]);
  const committed = f.ledger().files[f.a].committed;
  writeFileSync(f.a, 'keep=1\nrh=on\nuser=1\n');
  expect(f.gate().apply([f.change(f.a, 'on')]).written).toEqual([]);
  expect(f.ledger().files[f.a]).toMatchObject({ external_change: true, committed });

  const g = fixture();
  g.gate().delegate([g.a], ([target]) => writeFileSync(target!, 'rh=on\n'));
  writeFileSync(g.a, 'rh=on\nuser=1\n');
  expect(g.gate().delegate([g.a], () => {}).changed).toEqual([]);
  expect(g.ledger().files[g.a].external_change).toBe(true);
});

test('a file that the user edited before a later rh write is kept by a revert; the first backup stays, and the edited file goes to the vault apart', () => {
  for (const first of ['created', 'replaced', 'text_block'] as const) {
    // A whole-file writer may not replace a text_block file (see the user value test).
    for (const later of first === 'text_block' ? ['apply'] : ['apply', 'delegate']) {
      const f = fixture();
      const path = first === 'created' ? join(f.home, '.new.conf') : f.a;
      if (first === 'replaced') f.gate().delegate([path], ([target]) => writeFileSync(target!, 'rh=1\n'));
      else f.gate().apply([f.change(path, '1')]);
      writeFileSync(path, 'rh=1\nuser=precious\n');
      if (later === 'apply') f.gate().apply([f.change(path, '2')]);
      else f.gate().delegate([path], ([target]) => writeFileSync(target!, readFileSync(target!, 'utf8').replace('rh=1', 'rh=2')));
      const record = f.ledger().files[path];
      expect({ kind: record.kind, backup: record.backup === null ? null : f.vault(record.backup), external: f.vault(record.external_backup), revert: f.gate().revert().map((entry) => entry.action), text: readFileSync(path, 'utf8') })
        .toEqual({ kind: first, backup: first === 'created' ? null : 'keep=1\n', external: 'rh=1\nuser=precious\n', revert: ['kept_edited'], text: 'rh=2\nuser=precious\n' });
    }
  }
});

test('a file with rh text blocks reverts to its backup only while it holds the bytes rh recorded', () => {
  const f = fixture();
  const set = (values: Record<string, string>) => f.select(valueOnly, values);
  // One value at two selectors and an empty insertion revert exactly.
  writeFileSync(f.a, 'a=false\nb=false\nc=x\n');
  set({ a: 'true', b: 'true', c: '' });
  expect(readFileSync(f.a, 'utf8')).toBe('a=true\nb=true\nc=\n');
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['text_removed']);
  expect(readFileSync(f.a, 'utf8')).toBe('a=false\nb=false\nc=x\n');
  // The user changed rh's value and put the same text at another selector: the file stays.
  set({ a: 'true' });
  writeFileSync(f.a, 'a=custom\nb=true\nc=x\n');
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['kept_edited']);
  expect(readFileSync(f.a, 'utf8')).toBe('a=custom\nb=true\nc=x\n');
});

test('a revert restores the exact bytes from before rh, whatever the order of rh edits at one offset', () => {
  const users = 'a=USER-A\nb=USER-B\n';
  const runs: [HostConfigStrategy<string>, string, Record<string, string>[]][] = [
    [ownText, 'ab', [{ a: '', b: '' }]], [ownText, 'ab', [{ b: '', a: '' }]], [ownText, 'ab', [{ a: '', b: 'x' }]],
    [ownText, 'ab', [{ a: '' }, { b: '' }]], [ownText, 'ab', [{ b: '' }, { a: '' }]], [ownText, 'ab', [{ b: 'x' }, { a: '' }]],
    // Deleted lines, then a refresh of the second one or of both in reverse request order.
    [wholeLine, users, [{ a: '', b: '' }, { b: 'b=RH\n' }]], [wholeLine, users, [{ a: '' }, { b: '' }, { b: 'b=RH\n' }]],
    [wholeLine, users, [{ a: '', b: '' }, { b: 'b=RH\n', a: 'a=RH\n' }]],
  ];
  for (const [strategy, start, calls] of runs) {
    const f = fixture();
    writeFileSync(f.a, start);
    for (const values of calls) f.select(strategy, values);
    expect({ revert: f.gate().revert().map((entry) => entry.action), text: readFileSync(f.a, 'utf8') }).toEqual({ revert: ['text_removed'], text: start });
  }
});

test('a created directory keeps its record until a revert removes it', () => {
  const f = fixture();
  const b2 = join(f.home, '.tool', 'sub', 'b2.conf');
  const created = [join(f.home, '.tool'), join(f.home, '.tool', 'sub')];
  f.gate().apply([f.change(f.b, 'on'), f.change(b2, 'on')]);
  writeFileSync(b2, 'rh=on\nmine=1\n');
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['removed', 'kept_edited']);
  expect(f.ledger().directories).toEqual(created);
  writeFileSync(b2, 'rh=on\n');
  expect(f.gate().revert([b2]).map((entry) => entry.action)).toEqual(['removed']);
  expect({ tool: existsSync(created[0]!), directories: f.ledger().directories }).toEqual({ tool: false, directories: [] });
});

test('a user value at a recorded selector stays unless selected, and its bytes go to the vault before rh writes over them', () => {
  const f = fixture();
  writeFileSync(f.a, 'setting=original\n');
  const setting = (value: string, extra: Partial<HostConfigFileChange['fragments'][number]>) => f.gate().apply([f.change(f.a, value, { selector: 'setting', ...extra })]);
  setting('rh1', { kind: 'override', selected: true });
  writeFileSync(f.a, 'setting=USER-EDIT\n');
  expect(setting('rh2', { kind: 'refresh' })).toEqual({ written: [], skipped: [{ code: 'host_config_user_value_kept', file: f.a, owner: 'o1', selector: 'setting' }] });
  expect(readFileSync(f.a, 'utf8')).toBe('setting=USER-EDIT\n');
  setting('rh2', { kind: 'refresh', selected: true });
  expect({ backup: f.vault(f.ledger().files[f.a].backup), external: f.vault(f.ledger().files[f.a].external_backup), revert: f.gate().revert().map((entry) => entry.action), text: readFileSync(f.a, 'utf8') })
    .toEqual({ backup: 'setting=original\n', external: 'setting=USER-EDIT\n', revert: ['kept_edited'], text: 'setting=rh2\n' });
  // A whole-file writer may not replace a file that holds rh text blocks.
  f.gate().apply([f.change(f.a, 'on')]);
  expect(() => f.gate().delegate([f.a], ([target]) => writeFileSync(target!, 'external\n'))).toThrow(expect.objectContaining({ code: 'host_config_invalid_state' }));
  expect(readFileSync(f.a, 'utf8')).toBe('setting=rh2\nrh=on\n');
});

test('a revert releases a fragment claim that needed no write, for a named path and for all', () => {
  for (const only of [[], undefined]) {
    const f = fixture();
    writeFileSync(f.a, 'rh=on\n');
    expect(f.gate().apply([f.change(f.a, 'on')]).written).toEqual([]);
    expect(f.gate().revert(only && [f.a])).toEqual([{ path: f.a, action: 'released' }]);
    expect(f.gate().apply([f.change(f.a, 'on', { owner: 'o2' })]).written).toEqual([]);
    expect(readFileSync(f.a, 'utf8')).toBe('rh=on\n');
  }
});

test('A8: another owner on a recorded selector, a parent and a child selector, or one selector twice write nothing', () => {
  const f = fixture();
  const owners = { path: f.a, fragments: [
    { owner: 'o1', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o2', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '2' },
  ] };
  const nested = { path: f.b, fragments: [
    { owner: 'o1', selector: 'mcp', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o1', selector: 'mcp.codegraph', kind: 'add' as const, strategy: keyLine, value: '2' },
  ] };
  const twice = { path: f.a, fragments: [
    { owner: 'o1', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o1', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '1' },
  ] };
  for (const change of [owners, nested, twice]) {
    expect(() => f.gate().apply([change])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
  }
  expect({ a: readFileSync(f.a, 'utf8'), b: existsSync(f.b) }).toEqual({ a: 'keep=1\n', b: false });
  f.gate().apply([f.change(f.a, '1')]);
  expect(() => f.gate().apply([f.change(f.a, '2', { owner: 'o2' })])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
  // A fragment whose text is already in place is still recorded, without a file write.
  expect(f.gate().apply([f.change(f.a, '1', { selector: 'keep' })]).written).toEqual([]);
  expect(() => f.gate().apply([f.change(f.a, '2', { owner: 'o2', selector: 'keep' })])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
});

test('a target inside ~/.repo-harness is refused, also through a user link', () => {
  const f = fixture();
  mkdirSync(join(f.home, '.repo-harness'), { recursive: true });
  symlinkSync(join(f.home, '.repo-harness'), join(f.home, '.into-harness'));
  for (const path of [join(f.home, '.repo-harness', 'config.json'), join(f.home, '.into-harness', 'x.conf')]) {
    expect(() => f.gate().apply([f.change(path, 'on')])).toThrow(expect.objectContaining({ code: 'host_config_invalid_path' }));
  }
});

test('user links are followed: the real file is written and the link stays', () => {
  const f = fixture();
  mkdirSync(join(f.home, 'dotfiles'));
  symlinkSync(join(f.home, 'dotfiles'), join(f.home, '.linked'));
  symlinkSync(join(f.home, 'dotfiles', 'later.conf'), join(f.home, '.dangling.conf'));
  linkSync(f.a, join(f.home, '.hard'));
  const real = join(f.home, 'dotfiles', 'x.conf'), later = join(f.home, 'dotfiles', 'later.conf');
  expect(f.gate().apply([f.change(join(f.home, '.linked', 'x.conf'), 'on'), f.change(join(f.home, '.dangling.conf'), 'on'), f.change(f.a, 'on')]).written)
    .toEqual([real, later, f.a]);
  expect({ keys: Object.keys(f.ledger().files), linked: lstatSync(join(f.home, '.linked')).isSymbolicLink(), dangling: readFileSync(join(f.home, '.dangling.conf'), 'utf8') })
    .toEqual({ keys: [real, later, f.a], linked: true, dangling: 'rh=on\n' });
  let destinations: readonly string[] = [];
  f.gate().delegate([join(f.home, '.linked', 'y.conf')], (resolved) => { destinations = resolved; });
  expect(destinations).toEqual([join(f.home, 'dotfiles', 'y.conf')]);
  expect(() => f.gate().apply([f.change(real, 'a'), f.change(join(f.home, '.linked', 'x.conf'), 'b')])).toThrow(expect.objectContaining({ code: 'host_config_invalid_state' }));
});

test('a refresh with no recorded fragment is an override, adopt records an old write once, and a dry-run revert writes nothing', () => {
  const f = fixture();
  expect(f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'refresh' })]).skipped.map((entry) => entry.code)).toEqual(['host_config_override_skipped']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');

  writeFileSync(f.a, 'keep=1\nrh=old\n');
  const adoption = { backup: Buffer.from('keep=1\n'), fragments: [{ owner: 'o1', selector: 'rh', kind: 'add' as const, inserted: 'rh=old\n' }], externalChange: false };
  expect([f.gate().adopt(f.a, adoption), f.gate().adopt(f.a, { ...adoption, backup: null })]).toEqual(['adopted', 'recorded']);
  expect(f.ledger().files[f.a]).toMatchObject({ kind: 'text_block', baseline: { state: 'unknown' }, external_change: false });
  expect(f.gate().revert([f.a], { dryRun: true })).toEqual([{ path: f.a, action: 'text_removed' }]);
  expect({ text: readFileSync(f.a, 'utf8'), recorded: Object.keys(f.ledger().files) }).toEqual({ text: 'keep=1\nrh=old\n', recorded: [f.a] });
  expect(f.gate().revert([f.a]).map((entry) => entry.action)).toEqual(['text_removed']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
});

test('after a user edit, a revert removes intact add fragments, also after a refresh, restores an intact override from the first backup, and keeps an edited fragment', () => {
  const f = fixture();
  const path = join(f.home, 'conf.json');
  writeFileSync(path, '{"user":1,"o":"user"}');
  const json = (selector: string, kind: 'add' | 'refresh' | 'override', value: unknown) => ({ owner: 'o1', selector, kind, strategy: jsonFragment, value, selected: kind === 'override' });
  f.gate().apply([{ path, fragments: [json('a', 'add', 1), json('b', 'add', 1), json('o', 'override', 'rh')] }]);
  writeFileSync(path, readFileSync(path, 'utf8').replace('"user":1', '"user":2'));
  // The refresh after the outside edit keeps the first backup as the restore target and keeps the outside edit apart; the fragment kind stays `add`.
  const first = f.ledger().files[path].backup;
  f.gate().apply([{ path, fragments: [json('a', 'refresh', 2)] }]);
  expect([f.ledger().files[path].backup, typeof f.ledger().files[path].external_backup]).toEqual([first, 'string']);
  expect(f.ledger().fragments.map((entry: { selector: string; kind: string }) => [entry.selector, entry.kind])).toEqual([['b', 'add'], ['o', 'override'], ['a', 'add']]);
  writeFileSync(path, readFileSync(path, 'utf8').replace('"b":1', '"b":9'));
  expect(f.gate().revert([path])).toEqual([{ path, action: 'kept_edited', kept: ['b'] }]);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ user: 2, o: 'user', b: 9 });
  expect(f.ledger().fragments.map((entry: { selector: string }) => entry.selector)).toEqual(['b']);
});

test('a revert removes an emptied container only when the record proves rh created it, also under an owner filter; an override backup is 0600', () => {
  const f = fixture();
  const path = join(f.home, '.claude.json');
  const allow = { owner: 'o1', selector: 'permissions.allow[rule]', kind: 'add' as const, strategy: jsonFragment, value: 'rule' };
  for (const [original, filter, left] of [
    ['{"permissions":{"allow":[]},"theme":"dark"}', undefined, { permissions: { allow: [] }, theme: 'light' }],
    ['{"permissions":{"allow":[]},"theme":"dark"}', { owner: 'o1' }, { permissions: { allow: [] }, theme: 'light' }],
    ['{"permissions":{},"theme":"dark"}', { owner: 'o1' }, { permissions: {}, theme: 'light' }],
    ['{"theme":"dark"}', undefined, { theme: 'light' }],
    ['{"theme":"dark"}', { owner: 'o1' }, { theme: 'light' }],
  ] as const) {
    writeFileSync(path, original);
    f.gate().apply([{ path, backup: 'overrides-only', fragments: [allow] }]);
    writeFileSync(path, readFileSync(path, 'utf8').replace('dark', 'light'));
    expect(f.gate().revert([path], filter).map((entry) => entry.action), original).toEqual(['text_removed']);
    expect(JSON.parse(readFileSync(path, 'utf8')), original).toEqual(left);
    if (filter) f.gate().revert([path]);
  }
  writeFileSync(path, '{"mcpServers":{"codegraph":{"command":"user"}}}');
  const backup = f.gate().apply([{ path, backup: 'overrides-only', fragments: [{ owner: 'o1', selector: 'mcpServers.codegraph', kind: 'override', strategy: jsonFragment, value: { command: 'rh' }, selected: true }] }]);
  expect(backup.written.length).toBe(1);
  expect(statSync(join(f.root, 'vault', String(f.ledger().files[path].backup).replace('sha256:', ''))).mode & 0o777).toBe(0o600);
});
