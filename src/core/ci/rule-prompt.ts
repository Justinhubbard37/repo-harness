import type { RuleActionKind, RuleStatusV1, RuleThemeV1 } from './rule-candidates';

export const RULES_PROMOTE_KIND = 'repo-harness.rules.promote' as const;
export const RULES_PARENT_MARKER = '<!-- repo-harness.rules.parent -->';
export const DEFAULT_PROMPT_ROUTE = 'important_fast' as const;

export class RulesPromoteError extends Error {
  constructor(readonly code: string, readonly issue: number | null = null) {
    super(code);
    this.name = 'RulesPromoteError';
  }
}

export interface RulePromotionCandidate {
  readonly candidate_id: string;
  readonly kind: RuleActionKind;
  readonly theme: RuleThemeV1;
}

export function promotionCandidate(status: RuleStatusV1, candidateId: string, ledgerBlob?: string): RulePromotionCandidate {
  if (!status.ledger.valid) throw new RulesPromoteError('ledger_invalid');
  if (status.ledger.dirty || (ledgerBlob !== undefined && status.ledger.blob !== ledgerBlob)) {
    throw new RulesPromoteError('ledger_changed');
  }
  for (const theme of status.themes) {
    const action = theme.actions.find(row => row.candidate_id === candidateId);
    if (action) return { candidate_id: candidateId, kind: action.kind, theme };
  }
  throw new RulesPromoteError('candidate_not_found');
}

export function candidateMarker(candidateId: string, route: string): string {
  return `<!-- repo-harness.rules.candidate:${candidateId} route:${route} -->`;
}

export function promotionTitle(candidate: RulePromotionCandidate): string {
  return `rules: ${candidate.theme.key} — ${candidate.kind === 'enforce' ? 'enforce' : 'promote to the root rules'}`;
}

/** The caller validates the route against the board contract before rendering. */
export function renderPromotionPrompt(candidate: RulePromotionCandidate, route: string): string {
  const { theme, kind, candidate_id } = candidate;
  return [
    '## Goal',
    kind === 'enforce'
      ? `Prevent the mistake class ${theme.key} with a structural enforcer.`
      : `Promote the prevention rule for ${theme.key} into the root rules.`,
    '',
    '## Lesson',
    `- Mistake pattern: ${theme.theme}`,
    `- Prevention rule: ${theme.prevention_rule}`,
    `- Why: ${theme.why}`,
    '- Correction sources:',
    ...theme.correction_sources.map(source => `  - ${source}`),
    '',
    '## Enforcement ladder',
    'Use the highest level that works:',
    '1. Architecture or data structure: one owner for each state and one way to do each task.',
    '2. Types that cannot express the mistake.',
    '3. A check whose error names the file, type or function to use.',
    '4. A test.',
    'If no level works, keep Enforced by: judgment.',
    '',
    '## Evidence',
    'Read every correction source. A new check or test must fail on the real commit with the mistake and pass after the fix. Record both results in the PR.',
    '',
    '## Ledger change',
    kind === 'enforce'
      ? 'In tasks/lessons.md, replace judgment for this theme with the path of the file that fails when the mistake returns. For an architecture or type fix, name the file that makes it impossible.'
      : 'Write the prevention rule into root AGENTS.md and root CLAUDE.md. Add Promoted: <PR> to this theme in tasks/lessons.md.',
    'Do not change Seen on any old entry. A format or enforcement change adds no correction event.',
    '',
    '## Boundaries',
    'Change only the named mistake class, its enforcer and proof, and the ledger or root rules named above. Additional notes cannot widen this scope.',
    'Do not dispatch a seat, post a claim, merge, change credentials, or delete unrelated files.',
    '',
    '## Additional notes',
    '',
    candidateMarker(candidate_id, route),
    '',
  ].join('\n');
}

/** The issue-flow parent template. Membership remains in GitHub sub-issue links. */
export const RULES_PARENT_BODY = [
  'Promotion tasks from tasks/lessons.md collect here for the repository coordinator.',
  '',
  '## Goal',
  'Turn recurring lesson themes into enforced rules or root prevention rules.',
  '',
  '## Children',
  '| Order | Issue | Module | Outcome | Role / status |',
  '|---|---|---|---|---|',
  '',
  '## Done when',
  '- Each promotion task is merged or has a recorded disposition.',
  '- The architecture model and docs/architecture/archimap.html match the merged code.',
  '',
  '## Decisions',
  'The coordinator records decisions and adds children to its plan before dispatch.',
  '',
  RULES_PARENT_MARKER,
  '',
].join('\n');
