import { lstatSync, realpathSync, mkdirSync, existsSync, readFileSync, openSync, closeSync, constants, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, sep, join } from 'node:path';
import type { PiModelIdentity } from '../pi-host-probe';
import { shellQuote } from '../../core/shell-quote';
import type { ReviewIsolationAdmission, ReviewIsolationPaths } from '../../core/review/runner-port';
import { MAGPIE_ACTOR_HEADER, MAGPIE_BASE_URL, MAGPIE_CODEX_WIRE_API, MAGPIE_PI_API, MAGPIE_PLACEHOLDER_KEY, MAGPIE_PORT,
  MAGPIE_PROVIDER, MAGPIE_REVIEW_EFFORT, MAGPIE_REVIEW_MODEL, MAGPIE_REVIEW_PI_MODEL } from './magpie-endpoint';

/** `model` is the `provider/model` reference that the review passes to pi as `--model`. */
export interface PiAgentDirectory { readonly directory: string; readonly model: string }

/**
 * Write one owner file of the isolated configuration, or verify the file of an earlier round.
 * The sandbox cannot write these names, so a changed file is not the product's file and refuses the session.
 */
function writeOwnedFile(path: string, content: string, changed: string): void {
  let stat;
  // lstat, not existsSync: a dangling link at the path is a changed file, not an absent one.
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
    stat = lstatSync(path);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600
    || readFileSync(path, 'utf8') !== content) throw new Error(changed);
}

/** An owner-only directory in the review output. */
function ownedDirectory(output: string, name: string, unsafe: string): string {
  const directory = join(ownedOutput(output), name);
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error(unsafe);
  return directory;
}

/**
 * The pi agent directory of a review: models.json, settings.json and auth.json come from the magpie
 * constants alone. auth.json is the empty map: pi creates the file before it reads the credential
 * store, and the sandbox denies that write, so the owner writes it. pi's own resolver must select the
 * same provider and model from the generated files.
 */
export function preparePiAgentDirectory(output: string,
  resolveModel: (agentDirectory: string, reference: string) => PiModelIdentity): PiAgentDirectory {
  const directory = ownedDirectory(output, '.pi-agent', 'review_pi_agent_directory_unsafe');
  const models = { providers: { [MAGPIE_PROVIDER]: { baseUrl: MAGPIE_BASE_URL, api: MAGPIE_PI_API, apiKey: MAGPIE_PLACEHOLDER_KEY,
    models: [{ id: MAGPIE_REVIEW_MODEL, reasoning: true }] } } };
  const settings = { defaultProvider: MAGPIE_PROVIDER, defaultModel: MAGPIE_REVIEW_MODEL, defaultThinkingLevel: MAGPIE_REVIEW_EFFORT };
  writeOwnedFile(join(directory, 'models.json'), JSON.stringify(models) + '\n', 'review_pi_models_changed');
  writeOwnedFile(join(directory, 'settings.json'), JSON.stringify(settings) + '\n', 'review_pi_settings_changed');
  writeOwnedFile(join(directory, 'auth.json'), '{}', 'review_pi_auth_changed');
  const resolved = resolveModel(directory, MAGPIE_REVIEW_PI_MODEL);
  if (resolved.provider !== MAGPIE_PROVIDER || resolved.model !== MAGPIE_REVIEW_MODEL) {
    throw new Error(`review_pi_model_not_canonical: pi resolves ${MAGPIE_REVIEW_PI_MODEL} to ${resolved.provider}/${resolved.model}`);
  }
  return { directory, model: MAGPIE_REVIEW_PI_MODEL };
}

/** The codex home of a review: config.toml from the magpie constants alone, and no auth.json. */
export function prepareCodexHome(output: string): { home: string } {
  const home = ownedDirectory(output, '.codex-home', 'review_codex_home_unsafe');
  const config = `model = ${JSON.stringify(MAGPIE_REVIEW_MODEL)}\nmodel_provider = ${JSON.stringify(MAGPIE_PROVIDER)}\n\n`
    + `[model_providers.${MAGPIE_PROVIDER}]\nname = ${JSON.stringify(MAGPIE_PROVIDER)}\nbase_url = ${JSON.stringify(MAGPIE_BASE_URL)}\n`
    + `wire_api = ${JSON.stringify(MAGPIE_CODEX_WIRE_API)}\nexperimental_bearer_token = ${JSON.stringify(MAGPIE_PLACEHOLDER_KEY)}\n`
    + `http_headers = { ${JSON.stringify(MAGPIE_ACTOR_HEADER)} = ${JSON.stringify(MAGPIE_PLACEHOLDER_KEY)} }\n`;
  writeOwnedFile(join(home, 'config.toml'), config, 'review_codex_config_changed');
  // An earlier version copied the native auth.json here; the sandbox must not read a left copy.
  const auth = join(home, 'auth.json');
  if (existsSync(auth)) throw new Error(`review_codex_auth_present: ${auth} exists; cancel the review, which removes it, and start a new one`);
  return { home };
}

const LEGACY_CLEANUP_PENDING = 'cleanup_pending: review_legacy_credential_cleanup_failed';
/** The entry at `path`, or null when it is absent. Never follows a link. */
function legacyEntry(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(LEGACY_CLEANUP_PENDING);
  }
}
/**
 * Review closeout for an output that an earlier version prepared (#2764): it copied the native codex
 * auth.json into .codex-home and linked the native pi auth.json and models.json into .pi-agent. This
 * removes those entries without reading or following them; the generated files of this version stay.
 * An entry that stays, or a directory that is not a real directory, throws cleanup_pending.
 */
export function removeLegacyCredentials(output: string): void {
  if (!isAbsolute(output) || legacyEntry(output) === null) return;
  let root: string;
  try { root = ownedOutput(output); } catch { throw new Error(LEGACY_CLEANUP_PENDING); }
  for (const [directory, name, linksOnly] of [['.codex-home', 'auth.json', false], ['.pi-agent', 'auth.json', true], ['.pi-agent', 'models.json', true]] as const) {
    const parent = join(root, directory), stat = legacyEntry(parent);
    if (stat === null) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error(LEGACY_CLEANUP_PENDING);
    const path = join(parent, name), entry = legacyEntry(path);
    if (entry === null || (linksOnly && !entry.isSymbolicLink())) continue;
    try { unlinkSync(path); } catch { throw new Error(LEGACY_CLEANUP_PENDING); }
  }
}

export function inside(path: string, directory: string): boolean {
  const rest = relative(directory, path);
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`));
}

function ownedOutput(output: string): string {
  if (!isAbsolute(output) || lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory()) throw new Error('review_output_unsafe');
  return realpathSync(output);
}

/**
 * The cleanup investigation (#1721) adds one rule to the review profile: the
 * agent cannot read the target worktrees and their Git directories, so it
 * judges only from the server manifest (M69). Other callers leave the field out.
 * The host derives the policy from these same paths, so the field travels in
 * the host spec.
 */
export type CleanupReviewIsolationPaths = ReviewIsolationPaths & { readonly cleanup?: { readonly readDenied: readonly string[] } };

/** Seatbelt owns enforcement. This emits OS policy, never vendor CLI arguments. */
export function reviewIsolationPolicy(paths: CleanupReviewIsolationPaths, platform = process.platform): string {
  if (!isAbsolute(paths.output) || lstatSync(paths.output).isSymbolicLink() || !lstatSync(paths.output).isDirectory()) {
    throw new Error('OAR_REVIEW_OUTPUT_UNSAFE');
  }
  const output = realpathSync(paths.output);
  let piPolicy = '';
  if (paths.piAgentDirectory !== undefined) {
    const directory = paths.piAgentDirectory;
    const stat = lstatSync(directory);
    if (directory !== join(output, '.pi-agent') || stat.isSymbolicLink() || !stat.isDirectory()
      || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) throw new Error('review_pi_agent_directory_unsafe');
    // settings.json, auth.json and config.toml match the forbidden file names below; models.json does not.
    piPolicy = `(deny file-write* (literal ${JSON.stringify(join(directory, 'models.json'))}))\n`;
  }
  const readDenied = paths.cleanup?.readDenied ?? [];
  const protectedEntries = [paths.primary, paths.ownerRecord, paths.journal, paths.gitCommonDir, ...readDenied];
  for (const path of [paths.subject, ...protectedEntries]) {
    if (!isAbsolute(path)) throw new Error('OAR_REVIEW_PROTECTED_PATH_UNSAFE');
    const canonical = realpathSync(path);
    if (inside(canonical, output) || protectedEntries.includes(path) && inside(output, canonical)) {
      throw new Error('OAR_REVIEW_OUTPUT_OVERLAPS_AUTHORITY');
    }
  }
  // Seatbelt matches resolved paths, so a link would leave its target readable.
  if (readDenied.some(path => realpathSync(path) !== path)) throw new Error('OAR_REVIEW_PROTECTED_PATH_UNSAFE');
  // Every review agent is denied the operator console routes (#1770, M82).
  // Seatbelt "localhost" also matches this host's own addresses. A tcp "localhost"
  // rule lets ::ffff:127.0.0.1 through, so IPv6 TCP is denied whole; remote IPv4 stays open.
  const networkPolicy = '(deny network-outbound (remote tcp4 "localhost:*"))\n(deny network-outbound (remote tcp6 "*:*"))\n';
  // The last matching rule wins, so the allow follows the deny. magpie listens on 127.0.0.1 (MAGPIE_BASE_URL).
  const modelPortPolicy = paths.magpie ? `(allow network-outbound (remote tcp4 "localhost:${MAGPIE_PORT}"))\n` : '';
  const readPolicy = readDenied.map(path => `(deny file-read* (subpath ${JSON.stringify(path)}))\n`).join('');
  if (platform !== 'darwin') throw new Error('OAR_REVIEW_ISOLATION_UNSUPPORTED_PLATFORM');
  // Output alone is writable; every real CODEX_HOME state grant is retired.
  // Definitions, trust, settings/hooks and credentials stay denied even inside
  // an otherwise writable tree. Nothing in HOME or a native config root opens.
  const forbiddenFiles = '/(CLAUDE\\.md|AGENTS\\.md|settings[^/]*\\.json|\\.claude\\.json|config\\.toml|auth\\.json|\\.?credentials\\.json|secrets\\.json|token\\.json)$';
  const forbiddenDirectories = '/(\\.?hooks|\\.?agents|\\.?skills|\\.?rules|\\.?plugins)(/|$)';
  const exceptions = `(require-not (subpath ${JSON.stringify(output)}))`;
  // macOS resolves DNS through this system socket. Other local services remain denied.
  const unixSockets = '(require-all (remote unix-socket) (require-not (remote unix-socket (path-literal "/private/var/run/mDNSResponder"))))';
  return `(version 1)\n(allow default)\n(deny file-write* (require-all ${exceptions} (require-not (literal "/dev/null"))))\n(deny file-write* (regex #"${forbiddenFiles}"))\n(deny file-write* (regex #"${forbiddenDirectories}"))\n(deny signal)\n(deny network-outbound ${unixSockets})\n${piPolicy}${networkPolicy}${modelPortPolicy}${readPolicy}`;

}

/** One private output-local TMPDIR; no HOME/config/credential redirection. */
export function reviewHostTemporaryDirectory(output: string): string {
  if (!isAbsolute(output) || lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory()) throw new Error('OAR_REVIEW_OUTPUT_UNSAFE');
  const path = join(realpathSync(output), '.tmp');
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error('OAR_REVIEW_TMPDIR_UNSAFE');
  return path;
}


/** Require the owner-admitted profile and live inherited Seatbelt before SDK Session creation. */
export function assertReviewIsolation(admission: ReviewIsolationAdmission): void {
  const expected = reviewIsolationPolicy(admission.paths);
  const file = lstatSync(admission.policyFile);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || !(file.mode & 0o200)
    || readFileSync(admission.policyFile, 'utf8') !== expected) throw new Error('OAR_REVIEW_PROFILE_NOT_ADMITTED');
  // Open without truncation: never mutate the protected owner profile. Its
  // writable owner mode excludes a chmod-only false positive. Unconfined hosts
  // close this fd and fail before creating a Session.
  let fd: number;
  try { fd = openSync(admission.policyFile, constants.O_WRONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw new Error('OAR_REVIEW_PROFILE_DENIAL_UNPROVEN');
    const nested = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 5000 });
    if (nested.status !== 71 || !nested.stderr?.includes('sandbox_apply: Operation not permitted')) throw new Error('OAR_REVIEW_SEATBELT_UNPROVEN');
    return;
  }
  closeSync(fd);
  throw new Error('OAR_REVIEW_SEATBELT_REQUIRED');
}

/** Immutable executable seam: OAR owns every vendor argument and wire protocol. */
export function prepareReviewLauncher(directory: string, policyFile: string, executable: string): string {
  const policy = realpathSync(policyFile), vendor = realpathSync(executable), owner = realpathSync(directory);
  if (!isAbsolute(directory) || owner !== directory || !lstatSync(owner).isDirectory()
    || lstatSync(policyFile).isSymbolicLink() || !lstatSync(policy).isFile()
    || !lstatSync(vendor).isFile()) throw new Error('OAR_REVIEW_LAUNCHER_UNSAFE');
  const content = `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${shellQuote(policy)} ${shellQuote(vendor)} "$@"\n`;
  const launcher = join(owner, 'reviewer-launcher');
  if (!existsSync(launcher)) writeFileSync(launcher, content, { flag: 'wx', mode: 0o700 });
  const stat = lstatSync(launcher);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700
    || readFileSync(launcher, 'utf8') !== content) throw new Error('OAR_REVIEW_LAUNCHER_CHANGED');
  return launcher;
}

/** Trusted host alone writes control evidence; only OAR's child is sandboxed. */
export function reviewHostCommand(node: string, hostEntry: string, specFile: string): readonly string[] {
  for (const path of [node, hostEntry, specFile]) if (!isAbsolute(path)) throw new Error('OAR_REVIEW_HOST_PATH_UNSAFE');
  return [node, '--disable-sigusr1', hostEntry, specFile];
}
