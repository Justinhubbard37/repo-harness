import { useRef, useState, type ReactNode } from 'react';
import { Badge, Banner, Button, Loader, cn } from '@cloudflare/kumo';
import { WarningIcon, XIcon } from '@phosphor-icons/react';
import { ROUTING_CLASSES, type RoutingClass } from '../core/board/seats-settings';
import type { RuleCandidateActionV1, RuleGovernance, RuleTaskV1, RuleThemeV1 } from '../core/ci/rule-candidates';
import { isRulesPromptText, type RulesSnapshotV1 } from '../core/operator/rules';
import { useBoardSeats, type BoardSeatsReader } from './board-view';
import { copyOperatorIdentifier } from './clipboard';
import { DrawerFrame, useModalFocus } from './Drawer';
import type { OperatorMessageKey, OperatorTranslate } from './i18n';
import { OfficeAdvisorDialog, type AdvisorMessageWriter, type AdvisorTranscriptReader } from './OfficeAdvisorDialog';
import { WriteReloadBanner, type OperatorWriteFailure } from './operator-write';
import type { RulesPromoteWriter, RulesPromotionV1, RulesPromotionWrite, RulesReconcileWriter } from './rules';
import { CommandLine, ExternalLink, StatusDot, type DotTone } from './ui';

/** The reads and writes the drawer uses; App passes the production clients, tests pass doubles. */
export interface RulesDrawerPorts {
  readonly writePromote: RulesPromoteWriter;
  readonly writeReconcile: RulesReconcileWriter;
  readonly readBoardSeats: BoardSeatsReader;
  readonly readAdvisorTranscript: AdvisorTranscriptReader;
  readonly writeAdvisorMessage: AdvisorMessageWriter;
}

/** Governance is a filled pill; task progress is a dot and text, so the two never share a shape. */
const GOVERNANCE_TONE: Readonly<Record<RuleGovernance, string>> = {
  structural: 'bg-kumo-success-tint text-kumo-success',
  judgment_promoted: 'bg-kumo-fill text-kumo-default',
  judgment_unpromoted: 'bg-kumo-warning-tint text-kumo-warning',
};

export function GovernancePill({ governance, t }: { readonly governance: RuleGovernance; readonly t: OperatorTranslate }) {
  return <span data-rules-governance={governance}><Badge className={GOVERNANCE_TONE[governance]}>{t(`rules.governance.${governance}`)}</Badge></span>;
}

const PROGRESS_TONE: Readonly<Record<RuleTaskV1['progress'], DotTone>> = {
  waiting_orchestration: 'neutral', in_progress: 'active', ready_for_go: 'accent', merged: 'ok',
  closed_unfinished: 'neutral', pr_rejected: 'warn', failed: 'danger', unknown: 'unknown',
};
/** A task in one of these states blocks a new filing of its action. */
const OPEN_PROGRESS: readonly RuleTaskV1['progress'][] = ['waiting_orchestration', 'in_progress', 'ready_for_go', 'unknown'];
const isOpenTask = (task: RuleTaskV1 | null | undefined): boolean => task != null && OPEN_PROGRESS.includes(task.progress);

function progressText(task: RuleTaskV1, t: OperatorTranslate): string {
  const pr = task.pull_request;
  if ((task.progress === 'in_progress' || task.progress === 'merged') && pr !== null) return t(`rules.progress.${task.progress}.pr`, { number: pr.number });
  return t(`rules.progress.${task.progress}`);
}

/** The task progress of one action: dot and text, or "Not filed" with no dot. A merged task keeps its PR link. */
export function ProgressLabel({ task, t }: { readonly task: RuleTaskV1 | null | undefined; readonly t: OperatorTranslate }) {
  if (task == null) return <span className="text-kumo-subtle" data-rules-progress="none">{t('rules.task.notFiled')}</span>;
  const text = progressText(task, t);
  return (
    <span className="inline-flex items-center gap-1.5" data-rules-progress={task.progress}>
      <StatusDot tone={PROGRESS_TONE[task.progress]} />
      {task.progress === 'merged' && task.pull_request !== null ? <ExternalLink href={task.pull_request.url} className="relative z-10">{text}</ExternalLink> : text}
    </span>
  );
}

function Section({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2 border-t border-kumo-hairline pt-4">
      <h3 id={id} className="text-xs font-medium text-kumo-subtle">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-kumo-subtle">{label}</dt>
      <dd className="min-w-0 text-sm text-kumo-default [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

const GITHUB_ISSUE = /^#([1-9][0-9]*)$/u;

/** A `#n` source links to the issue of the ledger's repository; any other source is plain text. */
function CorrectionSource({ source, repository }: { readonly source: string; readonly repository: string | null }) {
  const issue = GITHUB_ISSUE.exec(source)?.[1];
  if (issue === undefined || repository === null) return <span className="font-mono text-xs">{source}</span>;
  return <ExternalLink href={`https://github.com/${repository}/issues/${issue}`} className="font-mono text-xs">{source}</ExternalLink>;
}

const LADDER = ['architecture', 'type', 'check', 'test'] as const;

function LessonBlock({ theme, repository, t }: { readonly theme: RuleThemeV1; readonly repository: string | null; readonly t: OperatorTranslate }) {
  const judgment = theme.enforced_by === 'judgment';
  return (
    <Section id="rules-drawer-lesson" title={t('rules.drawer.lesson')}>
      <dl className="flex flex-col gap-2">
        <Field label={t('rules.drawer.mistakePattern')}>{theme.theme}</Field>
        <Field label={t('rules.drawer.preventionRule')}>{theme.prevention_rule}</Field>
        <Field label={t('rules.drawer.why')}>{theme.why}</Field>
        <Field label={t('rules.drawer.corrections')}>
          <span className="flex flex-wrap gap-x-3 gap-y-1" data-rules-corrections={theme.correction_sources.length}>
            {theme.correction_sources.map(source => <CorrectionSource key={source} source={source} repository={repository} />)}
          </span>
        </Field>
        <Field label={t('rules.drawer.ladder')}>
          <ol className="flex flex-col gap-0.5" data-rules-ladder>
            {LADDER.map((level, index) => <li key={level}>{index + 1} {t(`rules.drawer.ladder.${level}`)}</li>)}
            <li data-rules-ladder-current={judgment || undefined}>
              {t('rules.drawer.ladder.judgment')}{judgment && <span className="ml-2 text-xs text-kumo-subtle">({t('rules.drawer.ladder.current')})</span>}
            </li>
          </ol>
          {!judgment && <p className="mt-1 font-mono text-xs text-kumo-subtle">{theme.enforced_by} ({t('rules.drawer.ladder.current')})</p>}
        </Field>
      </dl>
    </Section>
  );
}

/** The last line of a snapshot prompt is the candidate marker; the editor holds the text above it. */
function promptParts(prompt: string): { readonly body: string; readonly tail: string; readonly marker: string } {
  const end = prompt.endsWith('\n') ? prompt.length - 1 : prompt.length;
  const at = prompt.lastIndexOf('\n', end - 1) + 1;
  return { body: prompt.slice(0, at), tail: prompt.slice(at), marker: prompt.slice(at, end) };
}

/** The edited text plus the snapshot's marker line of the selected class, kept on its own line. */
const composePrompt = (body: string, tail: string): string => (body === '' || body.endsWith('\n') ? body : `${body}\n`) + tail;

/** Refusals that run before any GitHub call: the next Submit sends a new request. */
const RESUBMIT_CODES: readonly string[] = ['request_mismatch', 'prompt_marker_missing', 'rules_busy', 'prompt_write_failed'];
/** Refusals that ask for new page data or a fix outside the console; a reconcile cannot help. */
const REFRESH_CODES: readonly string[] = ['ledger_changed', 'candidate_not_found', 'ledger_invalid', 'rules_parent_ambiguous', 'herdr_unavailable', 'repository_unavailable', 'repository_not_found', 'registry_unavailable'];
const KNOWN_CODES: readonly string[] = ['candidate_open', 'ledger_changed', 'ledger_invalid', 'candidate_not_found', 'rules_parent_ambiguous', 'prompt_marker_missing', 'herdr_unavailable', 'request_mismatch'];

/** The result may exist: no typed answer, a 200 the decoder rejected, or a write the channel did not record. */
const uncertain = (failure: OperatorWriteFailure) => failure.state === 'unreachable' || failure.state === 'unreadable'
  || (failure.state === 'refused' && failure.error.code === 'reconcile_required');

type Refused = Extract<OperatorWriteFailure, { readonly state: 'refused' }>;

/**
 * `failed` keeps the Submit answer that left the attempt unresolved. A failed
 * Reconcile adds its answer beside it; only a filed issue or
 * `candidate_not_filed` resolves the attempt.
 */
type Outcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'filed'; readonly promotion: RulesPromotionV1; readonly via: 'submit' | 'reconcile' }
  | { readonly kind: 'failed'; readonly failure: OperatorWriteFailure; readonly reconcile?: OperatorWriteFailure }
  | { readonly kind: 'not_filed' };

function canSubmitAfter(outcome: Outcome): boolean {
  if (outcome.kind === 'none' || outcome.kind === 'not_filed') return true;
  return outcome.kind === 'failed' && outcome.failure.state === 'refused' && RESUBMIT_CODES.includes(outcome.failure.error.code);
}

/** Reconcile stays while the Submit attempt it recovers is unresolved. */
function canReconcileAfter(attempt: OperatorWriteFailure): boolean {
  if (attempt.state === 'reload_required') return false;
  if (attempt.state !== 'refused' || uncertain(attempt)) return true;
  const { code } = attempt.error;
  return !RESUBMIT_CODES.includes(code) && !REFRESH_CODES.includes(code);
}

/** The typed code of a refusal, its guidance and the issue when the answer names one. */
function RefusalDetail({ refused, guidance, noIssue, repository, t }: {
  readonly refused: Refused; readonly guidance?: string; readonly noIssue: boolean; readonly repository: string | null; readonly t: OperatorTranslate;
}) {
  const { error, issue } = refused;
  const known = KNOWN_CODES.includes(error.code);
  return (
    <span className="flex flex-col gap-1">
      <span className="font-mono text-xs">{error.code}</span>
      {guidance !== undefined ? <span>{guidance}</span> : <>
        <span>{known ? t(`rules.submit.refused.code.${error.code}` as OperatorMessageKey) : t('rules.refused.unknown', { code: error.code, message: error.message })}</span>
        {!known && <span>{error.next_action}</span>}
      </>}
      {issue !== undefined && <span data-rules-refusal-issue={issue}>{repository === null ? t('rules.submit.refused.issueExists', { issue })
        : <ExternalLink href={`https://github.com/${repository}/issues/${issue}`}>{t('rules.submit.refused.issueExists', { issue })}</ExternalLink>}</span>}
      {issue === undefined && noIssue && <span>{t('rules.submit.refused.noIssue')}</span>}
    </span>
  );
}

function FailureBanner({ failure, repository, t }: { readonly failure: OperatorWriteFailure; readonly repository: string | null; readonly t: OperatorTranslate }) {
  if (failure.state === 'reload_required') return <WriteReloadBanner t={t} />;
  if (uncertain(failure)) {
    const body = t('rules.submit.uncertain.body');
    return <Banner variant="alert" icon={<WarningIcon />} data-rules-submit="uncertain" data-rules-refusal={failure.state === 'refused' ? failure.error.code : undefined} title={t('rules.submit.uncertain.title')}
      description={failure.state === 'refused' ? <RefusalDetail refused={failure} guidance={body} noIssue={false} repository={repository} t={t} /> : body} />;
  }
  const refused = failure as Refused;
  const proved = RESUBMIT_CODES.includes(refused.error.code) || REFRESH_CODES.includes(refused.error.code);
  return <Banner variant="error" data-rules-submit="refused" data-rules-refusal={refused.error.code} title={t('rules.submit.refused.title')}
    description={<RefusalDetail refused={refused} noIssue={proved} repository={repository} t={t} />} />;
}

/** A failed Reconcile proves nothing about the Submit attempt, so it never says that no issue exists. */
function ReconcileFailureBanner({ failure, repository, t }: { readonly failure: OperatorWriteFailure; readonly repository: string | null; readonly t: OperatorTranslate }) {
  if (failure.state === 'reload_required') return <WriteReloadBanner t={t} />;
  return <Banner variant="error" data-rules-reconcile-failed={failure.state === 'refused' ? failure.error.code : failure.state} title={t('rules.reconcile.failed.title')}
    description={failure.state === 'refused' ? <RefusalDetail refused={failure} noIssue={false} repository={repository} t={t} /> : t('rules.reconcile.failed.uncertain')} />;
}

function OrchestrationMissing({ snapshot, t }: { readonly snapshot: RulesSnapshotV1; readonly t: OperatorTranslate }) {
  const orchestration = snapshot.status.orchestration;
  if (orchestration === undefined) return null;
  const { parent } = orchestration;
  const missing = parent === null ? [t('rules.orchestration.missing.parent')] : [
    ...(orchestration.plan_comment ? [] : [t('rules.orchestration.missing.planComment', { parent })]),
    ...(orchestration.coordinator_claim ? [] : [t('rules.orchestration.missing.coordinatorClaim', { parent })]),
  ];
  if (missing.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 text-sm" data-rules-orchestration-missing={missing.length}>
      <p className="text-kumo-default">{t('rules.orchestration.waiting')}</p>
      <ul className="list-disc pl-5 text-kumo-subtle">{missing.map(line => <li key={line}>{line}</li>)}</ul>
    </div>
  );
}

/** The `owner/name` of a `github:` status identity; a `local:` identity has none. */
const githubRepository = (snapshot: RulesSnapshotV1): string | null =>
  (snapshot.status.repository_id.startsWith('github:') ? snapshot.status.repository_id.slice('github:'.length) : null);

/** `--repository` is the GitHub identity of the status document; `--repository-id` is the numeric id of the seat read. */
function goCommand(snapshot: RulesSnapshotV1, githubRepositoryId: string | null, task: RuleTaskV1): string | null {
  const repository = githubRepository(snapshot);
  const pr = task.pull_request;
  if (repository === null || githubRepositoryId === null || pr === null) return null;
  return `rh publication merge --repository ${repository} --repository-id ${githubRepositoryId} --pr ${pr.number} --head ${pr.head_sha} --base ${pr.base_sha} --json`;
}

function TaskView({ task, theme, snapshot, githubRepositoryId, t }: {
  readonly task: RuleTaskV1; readonly theme: RuleThemeV1; readonly snapshot: RulesSnapshotV1;
  readonly githubRepositoryId: string | null; readonly t: OperatorTranslate;
}) {
  const open = isOpenTask(task);
  const go = task.progress === 'ready_for_go' ? goCommand(snapshot, githubRepositoryId, task) : null;
  return (
    <Section id="rules-drawer-task" title={t('rules.task.heading')}>
      <div className="flex flex-wrap gap-x-6 gap-y-2" data-rules-task={task.progress}>
        <div className="flex flex-col gap-1"><span className="text-xs text-kumo-subtle">{t('rules.task.progress')}</span><ProgressLabel task={task} t={t} /></div>
        <div className="flex flex-col gap-1"><span className="text-xs text-kumo-subtle">{t('rules.column.governance')}</span><GovernancePill governance={theme.governance} t={t} /></div>
      </div>
      {task.progress === 'waiting_orchestration' && <OrchestrationMissing snapshot={snapshot} t={t} />}
      {!open && task.issue !== null && <p className="text-sm text-kumo-default" data-rules-last-task>{t('rules.drawer.lastTask', { issue: task.issue, progress: progressText(task, t) })}</p>}
      <dl className="flex flex-col gap-2">
        <Field label={t('rules.task.issue')}>{task.issue !== null && task.url !== null ? <ExternalLink href={task.url}>#{task.issue}</ExternalLink> : '—'}</Field>
        <Field label={t('rules.task.route')}><span className="font-mono text-xs">{task.route ?? '—'}</span></Field>
        <Field label={t('rules.task.seat')}>{task.seat === null ? <span className="text-kumo-subtle">{t('rules.task.seat.none')}</span> : <span className="font-mono text-xs" data-rules-task-seat>{task.seat}</span>}</Field>
        <Field label={t('rules.task.pr')}>{task.pull_request === null ? <span className="text-kumo-subtle">{t('rules.task.pr.none')}</span> : <ExternalLink href={task.pull_request.url}>#{task.pull_request.number}</ExternalLink>}</Field>
        {task.progress === 'unknown' && task.reason !== undefined && <Field label={t('rules.task.progress')}><span className="font-mono text-xs">{task.reason}</span></Field>}
      </dl>
      {task.progress === 'ready_for_go' && (
        <div className="flex flex-col gap-1" data-rules-go>
          <span className="text-xs text-kumo-subtle">{t('rules.task.go')}</span>
          {go === null ? <p className="text-sm text-kumo-subtle" data-rules-go-unavailable>{t('rules.task.go.unavailable')}</p> : <>
            <p className="text-sm text-kumo-default">{t('rules.task.go.note')}</p>
            <CommandLine command={go} t={t} />
          </>}
        </div>
      )}
    </Section>
  );
}

function RouteList({ snapshot, route, onRoute, t }: {
  readonly snapshot: RulesSnapshotV1; readonly route: RoutingClass | null; readonly onRoute: (route: RoutingClass) => void; readonly t: OperatorTranslate;
}) {
  return (
    <Section id="rules-drawer-route" title={t('rules.drawer.route')}>
      <ul className="overflow-hidden rounded-lg border border-kumo-line" data-rules-routes>
        {ROUTING_CLASSES.map((name, index) => {
          const expected = snapshot.routes?.[index] ?? null;
          return (
            <li key={name} className="border-b border-kumo-hairline last:border-b-0">
              <label className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2 text-sm">
                <input type="radio" name="rules-route" value={name} checked={route === name} onChange={() => onRoute(name)} data-rules-route={name} />
                <span className="w-32 font-mono text-xs text-kumo-strong">{name}</span>
                <span className="font-mono text-xs text-kumo-subtle" data-rules-route-seat={expected?.seat ?? 'none'}>
                  {expected?.seat == null ? '—' : [expected.seat, expected.runtime, expected.model ?? '—'].join(' · ')}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-kumo-subtle">{t('rules.drawer.route.estimate')}</p>
    </Section>
  );
}

function CopyPrompt({ prompt, t }: { readonly prompt: string | null; readonly t: OperatorTranslate }) {
  const [status, setStatus] = useState<{ readonly prompt: string; readonly copied: boolean } | null>(null);
  const shown = status !== null && status.prompt === prompt ? status : null;
  return (
    <>
      <Button variant="secondary" disabled={prompt === null} data-rules-copy-prompt
        onClick={() => { if (prompt !== null) void copyOperatorIdentifier(prompt).then(copied => setStatus({ prompt, copied })); }}>
        {t('rules.drawer.copyPrompt')}
      </Button>
      <span className="text-xs text-kumo-subtle" role="status" aria-live="polite">
        {shown === null ? '' : t(shown.copied ? 'rules.drawer.copyPrompt.copied' : 'rules.drawer.copyPrompt.failed')}
      </span>
    </>
  );
}

/**
 * One open action: its task, the prompt editor, the routing class and the
 * writes. Keyed by candidate id, so another action starts with a clean state.
 * The status the panel shows comes from the snapshot; a write answer only
 * says what the request did.
 */
function ActionPanel({ snapshot, action, theme, githubRepositoryId, ports, advisor, onBusy, t }: {
  readonly snapshot: RulesSnapshotV1; readonly action: RuleCandidateActionV1; readonly theme: RuleThemeV1;
  readonly githubRepositoryId: string | null; readonly ports: RulesDrawerPorts; readonly advisor: ReactNode;
  /** The drawer holds close and the action switch while a write runs, so its answer is never dropped. */
  readonly onBusy: (busy: boolean) => void; readonly t: OperatorTranslate;
}) {
  const { ledger } = snapshot.status;
  const prompts = snapshot.prompts.filter(row => row.candidate_id === action.candidate_id);
  const [route, setRoute] = useState<RoutingClass | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const [busy, setBusy] = useState<'submit' | 'reconcile' | null>(null);
  const inFlight = useRef(false);

  const task = action.task;
  const open = isOpenTask(task);
  const selected = prompts.find(row => row.route === route) ?? null;
  const base = selected ?? prompts[0] ?? null;
  const parts = base === null ? null : promptParts(base.prompt);
  const body = draft ?? parts?.body ?? '';
  const prompt = selected === null ? null : composePrompt(body, promptParts(selected.prompt).tail);
  const writable = snapshot.herdr === 'ready' && ledger.valid && !ledger.dirty;
  const submitShown = writable && !open && canSubmitAfter(outcome) && prompts.length > 0;
  const submitReady = busy === null && prompt !== null && isRulesPromptText(prompt);

  const run = (kind: 'submit' | 'reconcile', send: () => Promise<RulesPromotionWrite>, failed: (failure: OperatorWriteFailure) => Outcome) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    onBusy(true);
    void send().then((answer) => {
      inFlight.current = false;
      setBusy(null);
      onBusy(false);
      setOutcome(answer.state === 'ok' ? { kind: 'filed', promotion: answer.value, via: kind } : failed(answer));
    });
  };
  const submit = () => {
    if (!submitShown || !submitReady || route === null || prompt === null) return;
    run('submit', () => ports.writePromote(snapshot.repository_id, {
      request_id: crypto.randomUUID(), candidate_id: action.candidate_id, route, ledger_blob: ledger.blob, prompt,
    }), failure => ({ kind: 'failed', failure }));
  };
  const reconcile = (attempt: OperatorWriteFailure) => run('reconcile', () => ports.writeReconcile(snapshot.repository_id, { request_id: crypto.randomUUID(), candidate_id: action.candidate_id }),
    failure => (failure.state === 'refused' && failure.error.code === 'candidate_not_filed' ? { kind: 'not_filed' } : { kind: 'failed', failure: attempt, reconcile: failure }));

  const filed = outcome.kind === 'filed' ? outcome.promotion : null;
  return (
    <>
      {task != null && <TaskView task={task} theme={theme} snapshot={snapshot} githubRepositoryId={githubRepositoryId} t={t} />}
      {filed !== null && (
        <div className="flex flex-col gap-1 border-t border-kumo-hairline pt-4 text-sm" data-rules-filed={filed.issue}>
          <p><ExternalLink href={filed.url}>{t('rules.task.filed', { issue: filed.issue })}</ExternalLink></p>
          {outcome.kind === 'filed' && outcome.via === 'reconcile' && <p className="text-kumo-subtle" data-rules-reconciled>{t('rules.reconcile.done', {
            issue: filed.issue, issueStep: t(`rules.reconcile.step.${filed.steps.issue}`),
            labelStep: t(`rules.reconcile.step.${filed.steps.label}`), subIssueStep: t(`rules.reconcile.step.${filed.steps.sub_issue}`),
          })}</p>}
          {task == null && <OrchestrationMissing snapshot={snapshot} t={t} />}
        </div>
      )}
      {!open && filed === null && <>
        <Section id="rules-drawer-prompt" title={t('rules.drawer.prompt')}>
          {parts === null ? <p className="text-sm text-kumo-subtle" data-rules-prompt-none>{t('rules.drawer.prompt.none')}</p> : <>
            <textarea className="min-h-48 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base p-3 font-mono text-[13px] leading-5 text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:outline-none"
              value={body} readOnly={busy !== null} aria-label={t('rules.drawer.prompt')} data-rules-prompt onChange={event => setDraft(event.target.value)} />
            <p className="font-mono text-xs text-kumo-subtle [overflow-wrap:anywhere]" data-rules-marker>{selected === null ? parts.marker : promptParts(selected.prompt).marker}</p>
            <p className="text-xs text-kumo-subtle">{t('rules.drawer.prompt.marker')}</p>
          </>}
        </Section>
        {parts !== null && <RouteList snapshot={snapshot} route={route} onRoute={setRoute} t={t} />}
      </>}
      {snapshot.herdr === 'unavailable' && !open && <p className="text-sm text-kumo-default" data-rules-herdr-unavailable>{t('rules.herdr.unavailable.body')}</p>}
      {outcome.kind === 'failed' && <FailureBanner failure={outcome.failure} repository={githubRepository(snapshot)} t={t} />}
      {outcome.kind === 'failed' && outcome.reconcile !== undefined && <ReconcileFailureBanner failure={outcome.reconcile} repository={githubRepository(snapshot)} t={t} />}
      {outcome.kind === 'not_filed' && <p className="text-sm text-kumo-default" data-rules-not-filed>{t('rules.reconcile.notFiled')}</p>}
      <footer className="flex flex-wrap items-center gap-2 border-t border-kumo-hairline pt-4">
        {submitShown && <Button variant="primary" onClick={submit} disabled={!submitReady} data-rules-submit-button>
          {busy === 'submit' ? <><Loader size={12} />{t('rules.drawer.submitting')}</> : t('rules.drawer.submit')}
        </Button>}
        {outcome.kind === 'failed' && canReconcileAfter(outcome.failure) && <Button variant="secondary" onClick={() => reconcile(outcome.failure)} disabled={busy !== null} data-rules-reconcile>
          {busy === 'reconcile' ? <><Loader size={12} />{t('rules.reconcile.running')}</> : t('rules.reconcile')}
        </Button>}
        {!open && filed === null && <CopyPrompt prompt={prompt} t={t} />}
        {advisor}
      </footer>
      {!open && filed === null && route === null && parts !== null && <p className="text-xs text-kumo-subtle" data-rules-route-required>{t('rules.drawer.route.required')}</p>}
    </>
  );
}

export function RulesCandidateDrawer({ snapshot, candidateId, generation, ports, onSelect, onClose, t }: {
  readonly snapshot: RulesSnapshotV1; readonly candidateId: string; readonly generation: number; readonly ports: RulesDrawerPorts;
  readonly onSelect: (candidateId: string) => void; readonly onClose: () => void; readonly t: OperatorTranslate;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [asking, setAsking] = useState(false);
  const [writing, setWriting] = useState(false);
  const close = () => { if (!asking && !writing) onClose(); };
  useModalFocus({ dialogRef, closeRef, identity: 'rules-candidate', onClose: close });
  const seats = useBoardSeats(ports.readBoardSeats, snapshot.repository_id, generation);
  const theme = snapshot.status.themes.find(row => row.actions.some(entry => entry.candidate_id === candidateId)) ?? null;
  const action = theme?.actions.find(entry => entry.candidate_id === candidateId) ?? null;
  const repository = githubRepository(snapshot);
  const seatDocument = seats?.kind === 'ready' ? seats.seats : null;
  const advisorSeat = seatDocument?.seats.find(seat => seat.seat === 'advisor') ?? null;
  const parent = snapshot.status.orchestration?.parent ?? null;
  const advisorBlocked = parent === null ? t('rules.drawer.askAdvisor.noParent')
    : advisorSeat === null && seats?.kind !== 'loading' ? t('rules.drawer.askAdvisor.noSeat') : null;
  const header = (
    <header className="flex items-start gap-3 border-b border-kumo-hairline px-5 py-4 sm:px-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id="rules-drawer-title" className="font-mono text-base font-semibold text-kumo-strong [overflow-wrap:anywhere]">{theme?.key ?? '—'}</h2>
        {theme !== null && <p className="text-xs text-kumo-subtle">{[theme.name ?? theme.theme, t('rules.seen', { count: theme.seen }), theme.lines.map(line => `L${line}`).join(', ')].join(' · ')}</p>}
      </div>
      {theme !== null && <GovernancePill governance={theme.governance} t={t} />}
      <button ref={closeRef} type="button" className="rounded-md p-1 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default" aria-label={t('rules.drawer.close')} aria-disabled={writing} onClick={close} data-rules-drawer-close>
        <XIcon size={16} aria-hidden="true" />
      </button>
    </header>
  );
  if (theme === null || action === null) {
    return (
      <DrawerFrame dialogRef={dialogRef} labelledBy="rules-drawer-title" closeLabel={t('rules.drawer.close')} onClose={close} header={header}>
        <p className="pt-4 text-sm text-kumo-default" data-rules-drawer-missing>{t('rules.drawer.notFound')}</p>
      </DrawerFrame>
    );
  }
  const advisor = (
    <>
      <Button variant="secondary" disabled={advisorBlocked !== null || advisorSeat === null} title={advisorBlocked ?? undefined} onClick={() => setAsking(true)} data-rules-ask-advisor>
        {t('rules.drawer.askAdvisor')}
      </Button>
      {advisorBlocked !== null && <span className="basis-full text-xs text-kumo-subtle" data-rules-advisor-blocked>{advisorBlocked}</span>}
    </>
  );
  return (
    <DrawerFrame dialogRef={dialogRef} labelledBy="rules-drawer-title" closeLabel={t('rules.drawer.close')} onClose={close} header={header}>
      <div className="flex flex-col gap-4 pt-4" data-rules-drawer={candidateId}>
        <LessonBlock theme={theme} repository={repository} t={t} />
        <Section id="rules-drawer-action" title={t('rules.drawer.action')}>
          {theme.actions.length === 1 ? <span className="text-sm text-kumo-strong">{t(`rules.action.${action.kind}`)}</span> : (
            <div className="flex gap-1" data-rules-action-switch>
              {theme.actions.map(entry => (
                <button key={entry.kind} type="button" aria-pressed={entry.candidate_id === candidateId} disabled={writing} onClick={() => onSelect(entry.candidate_id)} data-rules-action-pick={entry.kind}
                  className={cn('rounded-md border px-3 py-1 text-sm', entry.candidate_id === candidateId ? 'border-kumo-brand text-kumo-strong' : 'border-kumo-line text-kumo-subtle hover:text-kumo-default')}>
                  {t(`rules.action.${entry.kind}`)}
                </button>
              ))}
            </div>
          )}
        </Section>
        <ActionPanel key={candidateId} snapshot={snapshot} action={action} theme={theme} githubRepositoryId={seatDocument?.repository_id ?? null} ports={ports} advisor={advisor} onBusy={setWriting} t={t} />
      </div>
      {asking && parent !== null && advisorSeat !== null && (
        <OfficeAdvisorDialog repositoryId={snapshot.repository_id} parent={parent} agent={advisorSeat.agent ?? advisorSeat.address} portrait={null}
          read={ports.readAdvisorTranscript} write={ports.writeAdvisorMessage} onClose={() => setAsking(false)} t={t}
          initialDraft={t('rules.drawer.askAdvisor.draft', {
            key: theme.key, action: t(`rules.action.${action.kind}`), seen: theme.seen, governance: t(`rules.governance.${theme.governance}`), rule: theme.prevention_rule,
          })} />
      )}
    </DrawerFrame>
  );
}
