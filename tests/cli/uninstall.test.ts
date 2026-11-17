import { createHash } from 'crypto';
import { versions } from '../../src/cli/installer/install-profile';
import { beforeAll, test, expect } from 'bun:test';
import { installStateFixturePath, recordLegacyInstallOwnership, seedGlobalPackageFixture, seedPathRecords } from '../helpers/install-ownership';
import type { PathCommitted } from '../../src/core/host-config/types';
import { pathRecordHost, pathRecordKey } from '../../src/effects/host-config/path-records';
import { hashManagedTree } from '../../src/effects/managed-tree';
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, symlinkSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { spawnSync } from 'child_process';
import { runUserUninstall } from '../../src/cli/installer/uninstall';
import { configurationReceiptPath } from '../../src/cli/installer/configuration-ownership';
import { requestUserInputFragment } from '../../src/cli/installer/targets/codex';
import { tomlFragment } from '../../src/core/host-config/toml-fragment';
import { openHostConfigGate } from '../../src/effects/host-config/gate';
import { buildManagedHooks } from '../../src/cli/installer/managed-entries';
import { applyGlobalContextRefresh, preflightGlobalContextRefresh, renderGlobalRulesBlock } from '../../src/cli/installer/global-context';
const CLI = join(import.meta.dir, '../../src/cli/index.ts');
beforeAll(() => { seedGlobalPackageFixture(); });
function fixture(run: (home: string, env: NodeJS.ProcessEnv) => void) {
 const home = mkdtempSync(join(tmpdir(), 'user-uninstall-'));
 // Git config and the user excludes file resolve from the temporary HOME only.
 const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }; delete env.XDG_STATE_HOME; delete env.XDG_CONFIG_HOME; delete env.GIT_CONFIG_GLOBAL;
 try { run(home, env); } finally { rmSync(home, { recursive: true, force: true }); }
}
function put(home: string, path: string, content: string) { const absolute = join(home, path); mkdirSync(join(absolute, '..'), {recursive:true}); writeFileSync(absolute,content); }
/** rh's own write of the Codex input-mode key, through the host-config gate. */
function rhWritesInputMode(env: NodeJS.ProcessEnv, path: string) {
 openHostConfigGate({env}).apply([{path,fragments:[requestUserInputFragment(existsSync(path)?readFileSync(path,'utf8'):'')!]}]);
}
function ledger(home: string) { return JSON.parse(readFileSync(join(home,'.repo-harness/config/ledger.json'),'utf8')); }
function tree(home: string): string { return readdirSync(home, {recursive:true}).sort().map(String).map(p => {try{return `${p}:${readFileSync(join(home,p),'utf8')}`;}catch{return p;}}).join('\n'); }
test('restores original config, preserves siblings and archives, dry run is byte-identical', () => fixture((home, env) => {
 // An earlier rh version recorded its Codex change in the receipt; the first uninstall migrates it to the ledger.
 put(home,'.codex/config.toml','default_mode_request_user_input = true\nmodel = "user"\n');
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path:join(home,'.codex/config.toml'),selector:'default_mode_request_user_input',before:'default_mode_request_user_input = false\n',installed:'default_mode_request_user_input = true\n',active:true}]}));
 put(home,'.claude/settings.json',JSON.stringify({theme:'dark',hooks:{...buildManagedHooks('claude'),UserPromptSubmit:[{hooks:[{type:'command',command:'user-hook'}]}]}}));
 put(home,'.repo-harness/config.json',JSON.stringify({refactor_recommendations:{enabled:true},architecture:{projection_provider:'archctx',projection_apply:'manual'},custom:42}));
 put(home,'vault/archive.md','keep'); put(home,'.repo-harness/history/log','keep');
 const before=tree(home);
 const preview=runUserUninstall({target:'both',dryRun:true,env});
 expect(preview.status).toBe('complete'); expect(tree(home)).toBe(before);
 const result=runUserUninstall({target:'both',env}); expect(result.status).toBe('complete');
 expect(readFileSync(join(home,'.codex/config.toml'),'utf8')).toBe('default_mode_request_user_input = false\nmodel = "user"\n');
 expect(JSON.parse(readFileSync(join(home,'.claude/settings.json'),'utf8')).hooks.UserPromptSubmit[0].hooks[0].command).toBe('user-hook');
 expect(JSON.parse(readFileSync(join(home,'.repo-harness/config.json'),'utf8'))).toEqual({custom:42});
 expect(readFileSync(join(home,'vault/archive.md'),'utf8')).toBe('keep');
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect({receipt:existsSync(configurationReceiptPath(home)),files:ledger(home).files}).toEqual({receipt:false,files:{}});
}));
test('an interrupted Codex change in the receipt fails closed with its recovery step', () => fixture((home,env)=>{
 const path=join(home,'.codex/config.toml');
 put(home,'.codex/config.toml','default_mode_request_user_input = true\n');
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[],pending:{id:'x',before:[{path,selector:'default_mode_request_user_input',value:null}]}}));
 const before=tree(home);const result=runUserUninstall({target:'both',env});
 expect(result.status).toBe('partial');expect(result.lines.join('\n')).toContain('from its value in the "pending" block');expect(tree(home)).toBe(before);
}));
test('user edits are preserved and return partial, with the ledger record retained', () => fixture((home,env)=>{
 rhWritesInputMode(env,join(home,'.codex/config.toml'));
 put(home,'.codex/config.toml','default_mode_request_user_input = false\n');
 const result=runUserUninstall({target:'both',env});expect(result.status).toBe('partial');
 expect(readFileSync(join(home,'.codex/config.toml'),'utf8')).toContain('false');expect(Object.keys(ledger(home).files)).toHaveLength(1);
}));
test('fresh adapter-only uninstall is idempotent',()=>fixture((home,env)=>{
 rhWritesInputMode(env,join(home,'.codex/config.toml'));
 put(home,'.codex/hooks.json',JSON.stringify({hooks:buildManagedHooks('codex')}));
 expect(runUserUninstall({target:'both',env}).exitCode).toBe(0);
 // The migration does not prove that rh created the file or its event arrays, so they stay, empty.
 expect(Object.values(JSON.parse(readFileSync(join(home,'.codex/hooks.json'),'utf8')).hooks).flat()).toEqual([]);
 const after=tree(home);expect(runUserUninstall({target:'both',env}).exitCode).toBe(0);expect(tree(home)).toBe(after);
}));
test('target codex retains Claude and shared profile configuration',()=>fixture((home,env)=>{
 rhWritesInputMode(env,join(home,'.codex/config.toml'));
 put(home,'.claude/settings.json',JSON.stringify({hooks:buildManagedHooks('claude')}));
 put(home,'.repo-harness/config.json','{"security":{"mode":"strict"}}');
 const claude=readFileSync(join(home,'.claude/settings.json'),'utf8');
 expect(runUserUninstall({target:'codex',env}).exitCode).toBe(0);
 expect(readFileSync(join(home,'.claude/settings.json'),'utf8')).toBe(claude);expect(existsSync(join(home,'.repo-harness/config.json'))).toBe(true);
}));
const TRUST_NOTE='Codex keeps its hook trust entries in [hooks.state]; rh does not remove them.';
test('unrecorded TOML stays untouched beside a hook trust note',()=>fixture((home,env)=>{
 const raw='default_mode_request_user_input = true\n[hooks.state]\nopaque = true\n';put(home,'.codex/config.toml',raw);
 const result=runUserUninstall({target:'both',env});expect(result.exitCode).toBe(0);expect(readFileSync(join(home,'.codex/config.toml'),'utf8')).toBe(raw);expect(result.lines).toContain(`[note] ${join(home,'.codex/config.toml')}: ${TRUST_NOTE}`);
}));
test('hook trust entries alone are a note: uninstall completes and retires install state',()=>fixture((home,env)=>{
 put(home,'.codex/config.toml','[hooks.state."hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:a"\n');
 profile(home,[]);
 const result=runUserUninstall({target:'both',env});
 expect(result.exitCode,result.lines.join('\n')).toBe(0);expect(result.lines.at(-1)).toBe('[uninstall] complete');
 expect(result.lines.filter((line)=>line.startsWith('[note]'))).toEqual([`[note] ${join(home,'.codex/config.toml')}: ${TRUST_NOTE}`]);
 expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(false);
}));
test('CLI dry-run JSON creates no lock, receipt or directories',()=>fixture((home,env)=>{
 const before=tree(home);const result=spawnSync('bun',[CLI,'uninstall','--dry-run','--json'],{env:{...env,BUN_RUNTIME_TRANSPILER_CACHE_PATH:'0'},encoding:'utf8'});
 expect(result.status).toBe(0);expect(JSON.parse(result.stdout).dryRun).toBe(true);expect(tree(home)).toBe(before);
}));
test('malformed receipt prevents all mutation',()=>fixture((home,env)=>{
 put(home,'.repo-harness/configuration-restore.json','{"protocol":999}');
 put(home,'.codex/hooks.json',JSON.stringify({hooks:buildManagedHooks('codex')}));
 const before=tree(home);expect(runUserUninstall({target:'both',env}).exitCode).toBe(1);expect(tree(home)).toBe(before);
}));
test('a symlinked host root is followed: rh entries go from the linked hook file, and the link stays',()=>fixture((home,env)=>{
 put(home,'outside/hooks.json',JSON.stringify({hooks:buildManagedHooks('codex')}));symlinkSync(join(home,'outside'),join(home,'.codex'));
 expect(runUserUninstall({target:'both',env}).exitCode).toBe(0);expect(Object.values(JSON.parse(readFileSync(join(home,'outside/hooks.json'),'utf8')).hooks).flat()).toEqual([]);expect(lstatSync(join(home,'.codex')).isSymbolicLink()).toBe(true);
}));

test('restores existing MCP config without deleting sibling registrations or permissions',()=>fixture((home,env)=>{
 const path=join(home,'.claude.json');
 // An earlier rh version replaced the user's server and added the tool rule, and recorded both in its receipt.
 put(home,'.claude.json',JSON.stringify({mcpServers:{codegraph:{command:'new'},user:{command:'keep'}},allowedTools:['user-tool','mcp__codegraph__*']}));
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[
  {path,selector:'mcpServers.codegraph',before:JSON.stringify({command:'original'}),installed:JSON.stringify({command:'new'}),active:true},
  {path,selector:'allowedTools.codegraph',before:null,installed:JSON.stringify('mcp__codegraph__*'),active:true}]}));
 // An old Codex receipt entry beside a spelling that the Codex migration rejects: a Claude uninstall leaves both alone.
 const codex=join(home,'.codex/config.toml');const codexEntry={path:codex,selector:'default_mode_request_user_input',before:null,installed:'default_mode_request_user_input = true\n',active:true};
 put(home,'.codex/config.toml','"default_mode_request_user_input" = true\n');
 const receipt=JSON.parse(readFileSync(configurationReceiptPath(home),'utf8'));writeFileSync(configurationReceiptPath(home),JSON.stringify({...receipt,changes:[...receipt.changes,codexEntry]}));
 const result=runUserUninstall({target:'claude',env});expect(result.status,result.lines.join('\n')).toBe('complete');
 expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({mcpServers:{codegraph:{command:'original'},user:{command:'keep'}},allowedTools:['user-tool']});
 expect(readFileSync(codex,'utf8')).toBe('"default_mode_request_user_input" = true\n');
 expect(JSON.parse(readFileSync(configurationReceiptPath(home),'utf8')).changes).toContainEqual(codexEntry);
 expect(runUserUninstall({target:'claude',env}).status).toBe('complete');
}));
test('an old receipt entry whose value the user changed stays and is reported, in the dry run and in the uninstall',()=>fixture((home,env)=>{
 const path=join(home,'.claude.json');const edited=JSON.stringify({mcpServers:{codegraph:{command:'edited'}}});
 put(home,'.claude.json',edited);
 put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path,selector:'mcpServers.codegraph',before:null,installed:JSON.stringify({command:'new'}),active:true}]}));
 const line=`[unresolved] ${path}: changed since rh wrote it; preserved: mcpServers.codegraph`;
 for(const dryRun of [true,false]){const result=runUserUninstall({target:'claude',env,dryRun});expect(result.status,String(dryRun)).toBe('partial');expect(result.lines,String(dryRun)).toContain(line);}
 expect(readFileSync(path,'utf8')).toBe(edited);
}));
test('the migration keeps a container and a file that held only that container before rh',()=>fixture((home,env)=>{
 const path=join(home,'.claude.json');const server={command:'new'};
 for(const before of ['{"theme":"user","mcpServers":{}}','{"mcpServers":{}}']){
  put(home,'.claude.json',before.replace('{}',JSON.stringify({codegraph:server})));
  put(home,'.repo-harness/configuration-restore.json',JSON.stringify({protocol:1,changes:[{path,selector:'mcpServers.codegraph',before:null,installed:JSON.stringify(server),active:true}]}));
  expect(runUserUninstall({target:'claude',env}).status,before).toBe('complete');
  expect(readFileSync(path,'utf8'),before).toBe(before);
 }
}));
test('restores Codex MCP section while preserving other TOML tables',()=>fixture((home,env)=>{
 const path=join(home,'.codex/config.toml');
 put(home,'.codex/config.toml','model = "user"\n[mcp_servers.other]\ncommand = "keep"\n');
 openHostConfigGate({env}).apply([{path,fragments:[{owner:'architecture',selector:'mcp_servers.codegraph',kind:'add',strategy:tomlFragment,value:'[mcp_servers.codegraph]\ncommand = "cg"\n'}]}]);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');
 expect(readFileSync(path,'utf8')).toBe('model = "user"\n[mcp_servers.other]\ncommand = "keep"\n');
}));

/** A protocol 4 state and a `created` core record of each path, as an install leaves them. */
function profile(home: string, entries: readonly { path: string; committed: PathCommitted; kind?: 'user_managed' }[]) {
 const env={HOME:home};
 put(home,relative(home,installStateFixturePath(env)),JSON.stringify({protocol:4,...versions(['architecture']),selection:['architecture'],transaction_id:'fixture',applied_at:new Date().toISOString(),pi_packages:[],previous:null}));
 seedPathRecords(env,Object.fromEntries(entries.map(({path,committed,kind})=>[pathRecordKey(env,path),{owner:'core',host:pathRecordHost(env,path)!,kind:kind??'created' as const,baseline:{state:'unknown' as const},committed}])));
}
function ownedFile(path: string, content: string) { return {path,committed:{type:'file' as const,sha256:`sha256:${createHash('sha256').update(content).digest('hex')}`}}; }
function ownedLink(path: string, target: string) { return {path,committed:{type:'symlink' as const,target}}; }
/** A protocol 3 state with a manifest section record: the uninstall entry migrates it once. */
function legacyProfile(home: string, path: string, content: string) {
 const entry={owner:'architecture',authority:'repo-harness-install-transaction',removal:'managed-surfaces-only',path,type:'managed-file',content_hash:`sha256:${createHash('sha256').update(content).digest('hex')}`,managed_marker:'codegraph-config-projection',symlink_target:null};
 put(home,relative(home,installStateFixturePath({HOME:home})),JSON.stringify({protocol:3,...versions(['architecture']),selection:['architecture'],transaction_id:'fixture',applied_at:new Date().toISOString(),ownership_manifest:[entry],previous:null}));
}
test('removes profile-owned rules and retires profile but preserves user files',()=>fixture((home,env)=>{
 const path=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','owned');put(home,'.codex/rules/user.md','user');
 profile(home,[ownedFile(path,'owned')]);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');expect(existsSync(path)).toBe(false);
 expect(readFileSync(join(home,'.codex/rules/user.md'),'utf8')).toBe('user');expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(false);
}));
test('modified profile-owned rule remains retryable with ownership retained',()=>fixture((home,env)=>{
 const path=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','user-edited');profile(home,[ownedFile(path,'owned')]);
 expect(runUserUninstall({target:'both',env}).status).toBe('partial');expect(readFileSync(path,'utf8')).toBe('user-edited');expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(true);
 expect(Object.keys(ledger(home).paths)).toEqual([pathRecordKey({HOME:home},path)]);
}));
test('owned symlink removal never follows the skill source',()=>fixture((home,env)=>{
 put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.codex/skills'),{recursive:true});const path=join(home,'.codex/skills/check');symlinkSync(join(home,'source'),path);
 profile(home,[ownedLink(path,join(home,'source'))]);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');expect(existsSync(path)).toBe(false);expect(readFileSync(join(home,'source/SKILL.md'),'utf8')).toBe('keep');
}));
test('a codex uninstall keeps every claude record under a linked ~/.claude, and no uninstall removes a user-managed file',()=>fixture((home,env)=>{
 const dotfiles=join(home,'dotfiles/claude');mkdirSync(join(dotfiles,'skills'),{recursive:true});symlinkSync(dotfiles,join(home,'.claude'));
 put(home,'source/SKILL.md','keep');const link=join(home,'.claude/skills/check');symlinkSync(join(home,'source'),link);
 const rule=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','owned');
 const kept=join(home,'.codex/agents/explorer.toml');put(home,'.codex/agents/explorer.toml','mine');
 profile(home,[ownedLink(link,join(home,'source')),ownedFile(rule,'owned'),{...ownedFile(kept,'mine'),kind:'user_managed'}]);
 const key=(path: string)=>pathRecordKey({HOME:home},path);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');
 expect([existsSync(rule),lstatSync(link).isSymbolicLink(),readFileSync(kept,'utf8')]).toEqual([false,true,'mine']);
 expect(Object.keys(ledger(home).paths).sort()).toEqual([key(link),key(kept)].sort());
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect([existsSync(link),readFileSync(kept,'utf8'),ledger(home).paths]).toEqual([false,'mine',{}]);
}));
test('an uninstall keeps a personal file and a foreign skill that a path record names outside every install surface',()=>fixture((home,env)=>{
 const personal=join(home,'.codex/rules/personal.md');const foreign=join(home,'.claude/skills/foreign-skill');
 put(home,'.codex/rules/personal.md','mine');put(home,'.claude/skills/foreign-skill/SKILL.md','mine');
 profile(home,[ownedFile(personal,'mine'),{path:foreign,committed:{type:'directory' as const,sha256:hashManagedTree(foreign)}}]);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect([readFileSync(personal,'utf8'),readFileSync(join(foreign,'SKILL.md'),'utf8')]).toEqual(['mine','mine']);
}));
test('a dry run on a protocol 3 install plans the migrated records and writes nothing',()=>fixture((home,env)=>{
 const rule=join(home,'.codex/rules/anti-patterns.md');put(home,'.codex/rules/anti-patterns.md','owned');
 recordLegacyInstallOwnership([rule],env);const before=tree(home);
 expect(runUserUninstall({target:'both',dryRun:true,env}).lines).toContain(`[remove] ${pathRecordKey(env,rule)}: unchanged transaction-owned surface`);
 expect(tree(home)).toBe(before);
}));
test('staging skill removal edits the provider lock under an XDG_STATE_HOME outside HOME, after a failed cleanup',()=>fixture((home,env)=>{
 const state=mkdtempSync(join(tmpdir(),'user-uninstall-state-'));const lockPath=join(state,'skills/.skill-lock.json');
 try {
  put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.agents/skills'),{recursive:true});const path=join(home,'.agents/skills/think');symlinkSync(join(home,'source'),path);
  profile(home,[ownedLink(path,join(home,'source'))]);
  put(state,'skills/.skill-lock.json','{"skills":[]}');put(home,'.agents/.skill-lock.json','{"skills":{"think":{}}}');
  const xdg={...env,XDG_STATE_HOME:state};
  expect(runUserUninstall({target:'both',env:xdg}).status).toBe('partial');
  expect(existsSync(path)).toBe(true);expect(Object.keys(ledger(home).paths)).toContain(pathRecordKey({HOME:home},path));
  writeFileSync(lockPath,JSON.stringify({version:3,skills:{think:{source:'tw93/Waza'},'user-skill':{source:'user/repo'}}}));
  expect(runUserUninstall({target:'both',env:xdg}).status).toBe('complete');expect(existsSync(path)).toBe(false);
  expect(JSON.parse(readFileSync(lockPath,'utf8')).skills).toEqual({'user-skill':{source:'user/repo'}});
  expect(readFileSync(join(home,'.agents/.skill-lock.json'),'utf8')).toBe('{"skills":{"think":{}}}');
 } finally { rmSync(state,{recursive:true,force:true}); }
}));
test.skipIf(process.platform==='win32'||process.getuid?.()===0)('a failed provider lock write keeps the staging skill for a retry',()=>fixture((home,env)=>{
 const lockDir=join(home,'.local/state/skills');const xdg={...env,XDG_STATE_HOME:join(home,'.local/state')};
 put(home,'source/SKILL.md','keep');mkdirSync(join(home,'.agents/skills'),{recursive:true});const path=join(home,'.agents/skills/think');symlinkSync(join(home,'source'),path);
 profile(home,[ownedLink(path,join(home,'source'))]);
 put(home,'.local/state/skills/.skill-lock.json',JSON.stringify({skills:{think:{},'user-skill':{}}}));chmodSync(lockDir,0o500);
 expect(runUserUninstall({target:'both',env:xdg}).status).toBe('partial');
 expect(existsSync(path)).toBe(true);expect(Object.keys(ledger(home).paths)).toContain(pathRecordKey({HOME:home},path));
 chmodSync(lockDir,0o700);
 expect(runUserUninstall({target:'both',env:xdg}).status).toBe('complete');expect(existsSync(path)).toBe(false);
 expect(JSON.parse(readFileSync(join(lockDir,'.skill-lock.json'),'utf8')).skills).toEqual({'user-skill':{}});
}));
const RULES_BLOCK=renderGlobalRulesBlock(join(import.meta.dir,'../..'),{preset:'en',instruction:'Use English to report to user.'}).trimEnd();
test('managed context block cleanup keeps user prose',()=>fixture((home,env)=>{
 put(home,'.codex/AGENTS.md',`user-before\n${RULES_BLOCK}\nuser-after\n`);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');expect(readFileSync(join(home,'.codex/AGENTS.md'),'utf8')).toBe('user-before\nuser-after\n');
}));
test('rules blocks revert to the original bytes, keep a later user line and an edited block, and a shared link is one file',()=>fixture((home,env)=>{
 const root=join(import.meta.dir,'../..');const claude=join(home,'.claude/CLAUDE.md');const codex=join(home,'.codex/AGENTS.md');
 const install=()=>expect(applyGlobalContextRefresh(preflightGlobalContextRefresh(root,home,['codex','claude'],'en'),home).status).toBe('ok');
 put(home,'.claude/CLAUDE.md','claude notes');put(home,'.codex/AGENTS.md','codex notes\n');
 install();expect(readFileSync(claude,'utf8')).toBe(`claude notes\n\n${RULES_BLOCK}`);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect([readFileSync(claude,'utf8'),readFileSync(codex,'utf8')]).toEqual(['claude notes','codex notes\n']);
 expect(existsSync(join(home,'.repo-harness/global-context-backups'))).toBe(false);
 install();appendFileSync(codex,'later\n');writeFileSync(claude,readFileSync(claude,'utf8').replace('## Reporting','- My own rule.\n\n## Reporting'));
 const edited=readFileSync(claude,'utf8');const result=runUserUninstall({target:'both',env});
 expect(readFileSync(codex,'utf8')).toBe('codex notes\nlater\n');expect(readFileSync(claude,'utf8')).toBe(edited);
 expect(result.lines).toContain(`[unresolved] ${claude}: changed since rh wrote it; preserved: global-working-rules`);
 rmSync(claude);symlinkSync(codex,claude);install();
 expect(readFileSync(codex,'utf8').split(RULES_BLOCK)).toHaveLength(2);
 expect(runUserUninstall({target:'both',env}).status).toBe('complete');
 expect(readFileSync(codex,'utf8')).toBe('codex notes\nlater\n');expect(lstatSync(claude).isSymbolicLink()).toBe(true);
}));
test.each([
 ['.claude/CLAUDE.md',`user-before\n${RULES_BLOCK.replace('## Reporting','- My own rule.\n\n## Reporting')}\n`,'managed rules block'],
])('an edited managed block in %s keeps the file byte-identical and is unresolved',(path,content,name)=>fixture((home,env)=>{
 put(home,path,content);
 const result=runUserUninstall({target:'both',env});
 expect(result.exitCode).toBe(1);expect(readFileSync(join(home,path),'utf8')).toBe(content);
 expect(result.lines).toContain(`[unresolved] ${join(home,path)}: ${name} was edited; preserved. Move your rules outside the markers, then delete the block.`);
}));

test('old transaction-owned MCP projection composes with hook removal',()=>fixture((home,env)=>{
 const path=join(home,'.claude/settings.json');
 const server={command:'cg'};const allowedTools=['user-tool','mcp__codegraph__*'];
 put(home,'.claude/settings.json',JSON.stringify({mcpServers:{codegraph:server,user:{command:'keep'}},allowedTools,hooks:buildManagedHooks('claude')}));
 const projection=JSON.stringify({server,allowedTools:['mcp__codegraph__*']});
 legacyProfile(home,path,projection);
 const result=runUserUninstall({target:'both',env});expect(result.status,result.lines.join('\n')).toBe('complete');
 expect(JSON.parse(readFileSync(path,'utf8'))).toEqual({mcpServers:{user:{command:'keep'}},allowedTools:['user-tool'],hooks:Object.fromEntries(Object.keys(buildManagedHooks('claude')).map(event=>[event,[]]))});
}));
test('a reverted record cannot delete a user same-value setting after no-op reinstall',()=>fixture((home,env)=>{
 const path=join(home,'.codex/config.toml');
 rhWritesInputMode(env,path);
 expect(runUserUninstall({target:'codex',env}).status).toBe('complete');
 put(home,'.codex/config.toml','default_mode_request_user_input = true\n');
 // A user's `true` gives no request, so rh takes no new ownership.
 expect(requestUserInputFragment(readFileSync(path,'utf8'))).toBeNull();
 const result=runUserUninstall({target:'codex',env});
 expect(readFileSync(path,'utf8')).toContain('true');expect(result.status).toBe('complete');
}));
test('an old manifest record of the Codex CodeGraph table migrates to the ledger and uninstall removes the table',()=>{
 // The old manifest matched an indented header too.
 for(const table of ['[mcp_servers.codegraph]\ncommand = "cg"\n','  [mcp_servers.codegraph]\ncommand = "cg"\n'])fixture((home,env)=>{
  const path=join(home,'.codex/config.toml');
  put(home,'.codex/config.toml',`model = "user"\n${table}`);
  legacyProfile(home,path,table.trim());
  const result=runUserUninstall({target:'both',env});expect(result.status,result.lines.join('\n')).toBe('complete');
  expect(readFileSync(path,'utf8')).toBe('model = "user"\n');expect(existsSync(join(home,'.repo-harness/install-state.json'))).toBe(false);
 });
});
