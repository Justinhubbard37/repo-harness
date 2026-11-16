import { Badge, Banner, Loader, cn } from '@cloudflare/kumo';
import { WarningIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { RuleGovernance, RuleStatusV1, RuleThemeV1, TriageEvidenceErrorV1, TriageFieldErrorV1 } from '../core/ci/rule-candidates';
import type { RulesSnapshotV1 } from '../core/operator/rules';
import type { OperatorTranslate } from './i18n';
import { ageWords } from './labels';
import { useRulesSnapshot, type RulesRead, type RulesReader } from './rules';
import { BoardState, PageLink, StatusDot } from './ui';
import { RULES_LEDGER_ITEM, type WorkspaceLocation } from './workspace-location';

export type RulesSegment = 'candidates' | 'ledger';

export interface RulesPageProps {
  /** The repository the page reads; the page names itself when none is selected. */
  readonly repositoryId: string | null;
  readonly readRules: RulesReader;
  readonly generation: number;
  readonly now: number;
  readonly segment: RulesSegment;
  readonly onOpen: (next: WorkspaceLocation) => void;
  readonly t: OperatorTranslate;
}

const SEGMENT_LOCATION: Readonly<Record<RulesSegment, WorkspaceLocation>> = {
  candidates: { workspace: 'rules', module: null, item: null },
  ledger: { workspace: 'rules', module: null, item: RULES_LEDGER_ITEM },
};

/** Governance is a filled pill; task progress (#2888) will be a dot and text, so the two never share a shape. */
const GOVERNANCE_TONE: Readonly<Record<RuleGovernance, string>> = {
  structural: 'bg-kumo-success-tint text-kumo-success',
  judgment_promoted: 'bg-kumo-fill text-kumo-default',
  judgment_unpromoted: 'bg-kumo-warning-tint text-kumo-warning',
};

function GovernancePill({ governance, t }: { readonly governance: RuleGovernance; readonly t: OperatorTranslate }) {
  return <span data-rules-governance={governance}><Badge className={GOVERNANCE_TONE[governance]}>{t(`rules.governance.${governance}`)}</Badge></span>;
}

function ThemeCell({ theme }: { readonly theme: RuleThemeV1 }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="font-mono text-sm text-kumo-strong [overflow-wrap:anywhere]">{theme.key}</span>
      <span className="text-xs text-kumo-subtle">{theme.name ?? theme.theme}</span>
    </div>
  );
}

const Seen = ({ count, t }: { readonly count: number; readonly t: OperatorTranslate }) => (
  <span className="font-mono text-sm tabular-nums text-kumo-default">{t('rules.seen', { count })}</span>
);

/** A header row above wide rows; below the small breakpoint each row stacks and the header hides. */
function HeaderRow({ columns, labels }: { readonly columns: string; readonly labels: readonly string[] }) {
  return (
    <li aria-hidden="true" className={cn('hidden gap-3 px-3 text-xs font-medium text-kumo-subtle sm:grid', columns)}>
      {labels.map(label => <span key={label}>{label}</span>)}
    </li>
  );
}

const CANDIDATE_COLUMNS = 'sm:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.4fr)_minmax(0,1.4fr)]';

function CandidateList({ themes, t }: { readonly themes: readonly RuleThemeV1[]; readonly t: OperatorTranslate }) {
  return (
    <ul className="flex flex-col gap-1.5" data-rules-candidates={themes.length}>
      <HeaderRow columns={CANDIDATE_COLUMNS} labels={[t('rules.column.theme'), t('rules.column.seen'), t('rules.column.governance'), t('rules.column.actions')]} />
      {themes.map(theme => (
        <li key={theme.key} className={cn('grid gap-2 rounded-lg border border-kumo-line bg-kumo-base p-3 sm:items-center sm:gap-3', CANDIDATE_COLUMNS)} data-rules-candidate={theme.key}>
          <ThemeCell theme={theme} />
          <Seen count={theme.seen} t={t} />
          <div><GovernancePill governance={theme.governance} t={t} /></div>
          {/* Action labels only: the snapshot carries no task progress until #2888. */}
          <ul className="flex flex-col gap-0.5 text-sm text-kumo-default">
            {theme.actions.map(action => <li key={action.kind} data-rules-action={action.kind}>{t(`rules.action.${action.kind}`)}</li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

const LEDGER_COLUMNS = 'sm:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]';

function LedgerList({ themes, t }: { readonly themes: readonly RuleThemeV1[]; readonly t: OperatorTranslate }) {
  return (
    <ul className="flex flex-col gap-1.5" data-rules-ledger={themes.length}>
      <HeaderRow columns={LEDGER_COLUMNS} labels={[t('rules.column.theme'), t('rules.column.seen'), t('rules.column.enforcedBy'), t('rules.column.promoted'), t('rules.column.governance'), t('rules.column.lines')]} />
      {themes.map(theme => (
        <li key={theme.key} className={cn('grid gap-2 rounded-lg border border-kumo-line bg-kumo-base p-3 sm:items-center sm:gap-3', LEDGER_COLUMNS)} data-rules-theme={theme.key}>
          <ThemeCell theme={theme} />
          <Seen count={theme.seen} t={t} />
          <span className="font-mono text-xs text-kumo-default [overflow-wrap:anywhere]">{theme.enforced_by}</span>
          <span className="text-sm text-kumo-default">{theme.promoted ?? '—'}</span>
          <div className="flex flex-col gap-1">
            <GovernancePill governance={theme.governance} t={t} />
            {theme.governance === 'structural' && <span className="text-xs text-kumo-subtle">{t('rules.ledger.enforcer.notConnected')}</span>}
          </div>
          <span className="font-mono text-xs text-kumo-subtle">{theme.lines.map(line => `L${line}`).join(', ')}</span>
        </li>
      ))}
    </ul>
  );
}

function FieldErrorList({ errors, t }: { readonly errors: readonly TriageFieldErrorV1[]; readonly t: OperatorTranslate }) {
  return (
    <ul className="flex flex-col gap-1.5" data-rules-field-errors={errors.length}>
      {errors.map((error, index) => (
        <li key={index} className="flex flex-col gap-1 rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm" data-rules-field-error={error.line}>
          <p className="flex flex-wrap items-center gap-x-2 text-kumo-strong">
            <StatusDot tone="danger" />
            <span className="font-mono">{t('rules.ledger.error.line', { line: error.line })}</span>
            {error.theme !== '' && <span className="font-mono text-kumo-subtle">{error.theme}</span>}
          </p>
          <p className="font-mono text-xs text-kumo-default [overflow-wrap:anywhere]">{error.field}: {error.value}</p>
          <p className="text-kumo-default">{t('rules.ledger.error.fix', { fix: error.fix })}</p>
        </li>
      ))}
    </ul>
  );
}

/** Evidence rows carry no line (D7): the theme and its trigger value only. */
function EvidenceErrors({ errors, t }: { readonly errors: readonly TriageEvidenceErrorV1[]; readonly t: OperatorTranslate }) {
  return (
    <details className="text-sm" data-rules-evidence-errors={errors.length}>
      <summary className="cursor-pointer text-kumo-link">{t('rules.ledger.evidence.show', { count: errors.length })}</summary>
      <ul className="mt-1 flex flex-col gap-0.5">
        {errors.map((error, index) => (
          <li key={index} className="flex flex-wrap gap-x-2" data-rules-evidence-error={error.theme}>
            <span className="font-mono">{error.theme}</span>
            <span className="text-kumo-subtle">{t('rules.ledger.error.trigger', { trigger: error.trigger })}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One banner at most: invalid ledger, then evidence errors, then a dirty ledger. */
function LedgerBanner({ ledger, t }: { readonly ledger: RuleStatusV1['ledger']; readonly t: OperatorTranslate }) {
  if (ledger.field_errors.length > 0) {
    return <Banner variant="error" data-rules-banner="invalid" title={t('rules.ledger.invalid.title')} description={t('rules.ledger.invalid.body', { count: ledger.field_errors.length })} />;
  }
  if (ledger.evidence_errors.length > 0) {
    return (
      <>
        <Banner variant="alert" icon={<WarningIcon />} data-rules-banner="evidence" title={t('rules.ledger.evidence.title')}
          description={t('rules.ledger.evidence.body', { count: ledger.evidence_errors.length })} />
        <EvidenceErrors errors={ledger.evidence_errors} t={t} />
      </>
    );
  }
  if (ledger.dirty) return <Banner variant="alert" icon={<WarningIcon />} data-rules-banner="dirty" title={t('rules.ledger.dirty.title')} description={t('rules.ledger.dirty.body')} />;
  return null;
}

function SegmentTabs({ segment, counts, onOpen, t }: {
  readonly segment: RulesSegment;
  readonly counts: Readonly<Record<RulesSegment, number>> | null;
  readonly onOpen: (next: WorkspaceLocation) => void;
  readonly t: OperatorTranslate;
}) {
  return (
    <nav className="flex gap-1 border-b border-kumo-hairline" data-rules-segments>
      {(['candidates', 'ledger'] as const).map(name => (
        <PageLink key={name} to={SEGMENT_LOCATION[name]} onOpen={onOpen} data-rules-segment={name} aria-current={name === segment ? 'page' : undefined}
          className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm', name === segment ? 'border-kumo-brand text-kumo-strong' : 'border-transparent text-kumo-subtle hover:text-kumo-default')}>
          {t(`rules.segment.${name}`)}
          {/* An invalid ledger has no theme list, so it shows no count rather than 0. */}
          {counts !== null && <span className="rounded-full bg-kumo-recessed px-1.5 text-xs tabular-nums text-kumo-subtle">{counts[name]}</span>}
        </PageLink>
      ))}
    </nav>
  );
}

function RulesBody({ snapshot, segment, now, onOpen, t }: {
  readonly snapshot: RulesSnapshotV1; readonly segment: RulesSegment; readonly now: number;
  readonly onOpen: (next: WorkspaceLocation) => void; readonly t: OperatorTranslate;
}) {
  const { ledger, themes } = snapshot.status;
  const invalid = ledger.field_errors.length > 0;
  const candidates = themes.filter(theme => theme.actions.length > 0);
  let content: ReactNode;
  if (segment === 'ledger') content = invalid ? <FieldErrorList errors={ledger.field_errors} t={t} /> : <LedgerList themes={themes} t={t} />;
  else if (invalid) content = null;
  else if (candidates.length > 0) content = <CandidateList themes={candidates} t={t} />;
  else {
    content = (
      <div className="flex flex-col items-center gap-2" data-rules-empty>
        <BoardState title={t('rules.empty.title')} description={t('rules.empty.body')} />
        <PageLink to={SEGMENT_LOCATION.ledger} onOpen={onOpen} className="text-sm text-kumo-link hover:underline">{t('rules.empty.link')}</PageLink>
      </div>
    );
  }
  return (
    <>
      <p className="font-mono text-xs text-kumo-subtle" data-rules-source>
        {t('rules.source', { path: ledger.path, head: ledger.head.slice(0, 7), age: ageWords(snapshot.collected_at, now, t) })}
      </p>
      <SegmentTabs segment={segment} counts={invalid ? null : { candidates: candidates.length, ledger: themes.length }} onOpen={onOpen} t={t} />
      <LedgerBanner ledger={ledger} t={t} />
      {content}
    </>
  );
}

/** A waiting reason warns; a broken one fails. */
const WAITING_REASONS: readonly string[] = ['rules_pending', 'registry_unavailable', 'repository_not_found'];

function RulesRefusal({ read, t }: { readonly read: Exclude<RulesRead, { readonly state: 'ok' }>; readonly t: OperatorTranslate }) {
  const known = read.state === 'unavailable';
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-kumo-line bg-kumo-base p-4 sm:p-5" data-rules-unavailable={known ? read.reason : read.code}>
      <p className="flex items-center gap-2 text-sm text-kumo-default">
        <StatusDot tone={known && WAITING_REASONS.includes(read.reason) ? 'warn' : 'danger'} />
        {known ? t(`rules.reason.${read.reason}`) : t('rules.refused.unknown', { code: read.code, message: read.message })}
      </p>
    </section>
  );
}

/**
 * The read-only Rules page: the promotion candidates and the full lessons
 * ledger of one repository, as the cached `rh rules status` document states
 * them. The page computes no candidate and sends no write.
 */
export function RulesPage({ repositoryId, readRules, generation, now, segment, onOpen, t }: RulesPageProps) {
  const read = useRulesSnapshot(readRules, repositoryId, generation);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-rules-page>
      <header className="flex flex-col gap-1 border-b border-kumo-hairline pb-4">
        <h1 className="text-xl font-semibold text-kumo-strong">{t('nav.rules')}</h1>
        <p className="text-sm text-kumo-subtle">{t('rules.boundary')}</p>
      </header>
      {repositoryId === null ? <p role="status" className="text-sm text-kumo-subtle">{t('repository.select')}</p>
        : read === null ? <p role="status" className="flex items-center gap-1.5 text-sm text-kumo-subtle" data-rules-loading><Loader size={12} />{t('rules.loading')}</p>
        : read.state !== 'ok' ? <RulesRefusal read={read} t={t} />
        : <RulesBody snapshot={read.snapshot} segment={segment} now={now} onOpen={onOpen} t={t} />}
    </div>
  );
}
