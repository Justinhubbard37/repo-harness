import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, initGitRepo, run, tmpWorkspace } from '../helpers/repo-fixture';
import { seedReviewAdmissionFixture } from '../helpers/review-admission-fixture';

const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'src/cli/index.ts');

describe('verify command', () => {
  test('forwards helper arguments, output and failures; retired and unknown routes run nothing', () => {
    const root = tmpWorkspace('verify-cli');
    try {
      mkdirSync(join(root, 'assets'));
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, 'assets/workflow-contract.v1.json'), JSON.stringify({ helpers: {
        scripts: ['verify-sprint.sh', 'verification-plan.ts'], internal: ['verification-plan', 'verify-sprint'],
      } }));
      writeFileSync(join(root, 'scripts/verify-sprint.sh'), 'printf "%s\\n" "$@"; echo helper-error >&2; touch ran; exit 17\n');
      writeFileSync(join(root, 'scripts/verification-plan.ts'), 'console.log(process.argv.slice(2).join("\\n")); console.error("helper-error"); require("fs").writeFileSync("ran", ""); process.exit(17);\n');
      const env = { REPO_HARNESS_SOURCE_ROOT: root };
      for (const [helper, replacement] of [['verify-sprint', 'rh verify'], ['verification-plan', 'rh verify plan']] as const) {
        for (const id of [helper, `${helper}.${helper === 'verify-sprint' ? 'sh' : 'ts'}`]) {
          const result = run(process.execPath, [CLI, 'run', id], root, env);
          expect(result.status).toBe(2);
          expect(result.stderr).toContain(`Use \`${replacement}\`.`);
          expect(existsSync(join(root, 'ran'))).toBe(false);
        }
      }
      for (const action of ['nosuch', 'execute-eval']) {
        const result = run(process.execPath, [CLI, 'verify', 'plan', action], root, env);
        expect(result.status).toBe(2);
        expect(result.stderr.trim()).toBe(`rh verify plan: unknown action "${action}" (expected: validate, evaluate, execute)`);
        expect(existsSync(join(root, 'ran'))).toBe(false);
      }
      for (const [route, args] of [
        [[], ['--test', 'tests/a b.test.ts', '--base', 'plan', '--help', '-h']],
        [[], []],
        [['plan'], ['validate', '--repo', root, '--help']],
        [['plan'], ['evaluate', '--report-file', 'a b.json', '-h']],
        [['plan'], ['execute', '--timeout-ms', '7', '--force-reason', 'two words', '--', 'literal']],
      ] as const) {
        const result = run(process.execPath, [CLI, 'verify', ...route, ...args], root, env);
        expect(result.status, result.stderr).toBe(17);
        expect(result.stdout).toBe(`${args.join('\n')}\n`);
        expect(result.stderr).toBe('helper-error\n');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('plan execute runs the same admitted check as the script', () => {
    const root = tmpWorkspace('verify-plan-cli');
    const home = tmpWorkspace('verify-plan-home');
    try {
      initGitRepo(root);
      writeFileSync(join(root, '.gitignore'), '.ai/\nrunner/\n');
      writeFileSync(join(root, 'source.txt'), 'fixture\n');
      commitAll(root, 'fixture');
      const approval = seedReviewAdmissionFixture(root, home, { plan: { protocol: 1, checks: [{
        id: 'selected', kind: 'command', command: 'printf selected', cwd: '.', phase: 'verification', cost: 'normal',
        evidence_policy: 'current_exact', necessity: 'Prove the CLI executes the admitted check.', inputs: { env: [] },
      }] } });
      const sourceRoot = join(root, 'runner');
      mkdirSync(join(sourceRoot, 'scripts'), { recursive: true });
      mkdirSync(join(sourceRoot, 'assets'));
      writeFileSync(join(sourceRoot, 'assets/workflow-contract.v1.json'), JSON.stringify({ helpers: {
        scripts: ['verification-plan.ts'], internal: ['verification-plan'],
      } }));
      const script = join(sourceRoot, 'scripts/verification-plan.ts');
      writeFileSync(script, `
        import { main } from ${JSON.stringify(join(ROOT, 'scripts/verification-plan.ts'))};
        const source = ${JSON.stringify(approval.source)};
        source.runner = args => ({ stdout: JSON.stringify(args.includes('repos/acme/widgets/issues/903')
          ? ${JSON.stringify(approval.issue)} : { id: 'R_provider', full_name: 'acme/widgets', html_url: 'https://github.com/acme/widgets' }) });
        process.exit(await main(process.argv.slice(2), () => source));
      `);
      const args = ['execute', '--repo', root, '--report-file', '.ai/harness/checks/cli.json'];
      const result = run(process.execPath, [CLI, 'verify', 'plan', ...args], root, { REPO_HARNESS_SOURCE_ROOT: sourceRoot });
      expect(result.status, result.stderr).toBe(0);
      const cliReport = JSON.parse(readFileSync(join(root, '.ai/harness/checks/cli.json'), 'utf8'));
      expect(cliReport.passed).toBe(true);
      expect(cliReport.results[0].execution).toBe('executed');
      const direct = run(process.execPath, [script, 'execute', '--repo', root, '--report-file', '.ai/harness/checks/direct.json'], root);
      expect(direct.status, direct.stderr).toBe(result.status);
      const directReport = JSON.parse(readFileSync(join(root, '.ai/harness/checks/direct.json'), 'utf8'));
      expect(directReport.passed).toBe(true);
      expect(directReport.results[0].execution).toBe('reused');
      expect(directReport.results[0].execution_id).toBe(cliReport.results[0].execution_id);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
