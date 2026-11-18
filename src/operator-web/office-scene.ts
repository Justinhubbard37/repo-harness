import type { AdvisorBossCommand } from '../core/board/advisor-seat';
import type { BoardAcceptanceMergeV1 } from '../core/board/board';
import type { DeskState } from '../core/board/desk';
import {
  agentBody, agentPalette, BOSS, BOSS_PALETTE, CARROT, CARROT_PALETTE, miniAgent, SHADE_DARK, SHADE_LIGHT, SHADE_SUN, textWidth,
  type BossPose, type FrontPose, type Outfit, type PxColor, type PxMap, type SceneAgent,
} from './office-sprites';
import {
  badge, deskBody, deskCell, door, FrameBuffer, plant, queuer, seatedCell, shadow, sign, type ScenePath,
} from './office-scene-primitives';

export { agentPortrait, bossPortrait, deskVignette, type ScenePath } from './office-scene-primitives';

/** The 4x8 world: 4 desks per row. */
const DESK_COLUMNS = 4;
const DESK_X = [0, 80, 160, 240] as const;
const DESK_TOP = 136;
const DESK_ROW = 52;
const BASE_HEIGHT = 240;
const QUEUE_X = [160, 136, 112] as const;
const DESK_OUTFITS: readonly Outfit[] = ['cap', 'beanie', 'crown', 'scarf', 'plain', 'cap', 'beanie', 'crown'];
const QUEUE_OUTFITS: readonly Outfit[] = ['bowtie', 'beanie', 'plain'];
const STAGE_OUTFIT = { orchestrator: 'headset', advisor: 'glasses' } as const;
/** The whiteboard shows at most 8 issue numbers: two lines of 4. */
const BOARD_LINE = 4;
/** The sign is 80 grid px at most, so a long name stops before the window. */
const SIGN_MAX_CHARS = 18;

export const deskOutfit = (index: number): Outfit => DESK_OUTFITS[index % DESK_OUTFITS.length]!;
export const queueOutfit = (index: number): Outfit => QUEUE_OUTFITS[index % QUEUE_OUTFITS.length]!;
export const stageOutfit = (seat: keyof typeof STAGE_OUTFIT): Outfit => STAGE_OUTFIT[seat];

/** How long the room plays a boss command after the server accepted it (the mockup value). */
export const BOSS_EFFECT_MS = 15_000;

export type BossEffect = AdvisorBossCommand;

export interface SceneDesk {
  readonly key: string;
  readonly agent: SceneAgent;
  readonly state: DeskState;
  readonly number: string;
  readonly label: string;
}

export interface SceneQueueEntry {
  readonly key: string;
  readonly agent: SceneAgent;
  readonly pr: number;
}

/** Stands the actor at its action spot: inside the act of every command, with the 排雷 sweep done. */
const BOSS_STILL_MS = 12000;

/** The effect of a scene frame. Reduced motion keeps the effect and its 15 seconds, without the walk. */
export function sceneEffect(effect: { readonly command: BossEffect; readonly at: number } | null, now: number, still: boolean): SceneView['effect'] {
  if (effect === null || now - effect.at >= BOSS_EFFECT_MS) return null;
  return { command: effect.command, elapsedMs: still ? BOSS_STILL_MS : now - effect.at };
}

export interface SceneRoom {
  readonly name: string;
  readonly parent: number | null;
  /** Occupancy only. False when the repository has no live seat: the night palette, the lamp lit. */
  readonly lit: boolean;
  readonly orchestrator: SceneAgent | null;
  readonly advisor: SceneAgent | null;
  /** `reading` while the board read of the room is pending; null when the board has no plan. */
  readonly plan: { readonly revision: number | null; readonly order: readonly number[]; readonly limit: number } | 'reading' | null;
  /** The worker limit that sets the free and the roped desks. */
  readonly limit: number;
  readonly desks: readonly SceneDesk[];
  readonly queue: readonly SceneQueueEntry[];
  readonly tray: number;
  /** The merge policy of the door while a pull request waits; null when none waits. */
  readonly mergeWait: BoardAcceptanceMergeV1 | null;
  /** Desks that an R2 or R3 finding names, by desk key. */
  readonly mines: ReadonlyMap<string, string>;
  readonly text: {
    readonly noParent: string;
    readonly orchestrator: string;
    readonly advisor: string;
    readonly tray: string;
    readonly queue: string;
    readonly seat: (index: number) => string;
    readonly free: string;
    readonly roped: string;
    readonly mine: (rule: string) => string;
    readonly say: (command: BossEffect) => string;
  };
}

export interface SceneView {
  readonly frame: number;
  readonly night: boolean;
  readonly advisorBusy: boolean;
  /** The accepted command and the time since the answer; null when none plays. */
  readonly effect: { readonly command: BossEffect; readonly elapsedMs: number } | null;
}

export type SceneTone = 'info' | 'danger' | 'warn' | 'subtle' | 'ok';

export interface SceneLabel {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly text: string;
  readonly kind: 'plain' | 'plaque' | 'paper';
}

export interface SceneDeskLabel {
  readonly x: number;
  readonly y: number;
  readonly number: string;
  readonly text: string;
  readonly tone: SceneTone;
  readonly dim: boolean;
}

export interface SceneHit {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SceneTag {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly tone: 'mine' | 'speech';
}

export interface ComposedScene {
  readonly width: number;
  readonly height: number;
  readonly paths: readonly ScenePath[];
  readonly labels: readonly SceneLabel[];
  readonly deskLabels: readonly SceneDeskLabel[];
  readonly hits: readonly SceneHit[];
  readonly tags: readonly SceneTag[];
}

const STATE_TONE: Readonly<Record<DeskState, SceneTone>> = {
  blocked: 'warn', error: 'danger', coding: 'info', ci_pending: 'info', ci_failed: 'danger', no_claim_status: 'warn', acceptance_queue: 'subtle', done: 'ok', idle: 'subtle', unknown: 'subtle',
};

interface BossActor {
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly sprite: BossPose;
  readonly frame: number;
  readonly acting: boolean;
  /** The furthest desk row x the mine walk has reached; null outside that walk. */
  readonly mineSeen: number | null;
}

const BOSS_ACTION: Readonly<Record<BossEffect, BossPose>> = { rage: 'stick', carrot: 'happy', mine: 'inspect', valve: 'valve' };

/** The boss walks from the door to the stage, or along the desk row for 排雷, acts and walks back. */
function bossActor(command: BossEffect, elapsedMs: number, frame: number): BossActor {
  const entry = { x: 288, y: 24 };
  const spot = { x: 228, y: 64 };
  const mine = command === 'mine';
  const path = mine ? [entry, { x: 296, y: 110 }, { x: 4, y: 110 }, { x: 4, y: 110 }, entry] : [entry, spot, spot, spot, entry];
  const cuts = mine ? [0, 2500, 11500, 12500, 15000] : [0, 2500, 7500, 12500, 15000];
  let segment = 0;
  while (segment < 3 && elapsedMs >= cuts[segment + 1]!) segment += 1;
  const progress = Math.min(1, (elapsedMs - cuts[segment]!) / (cuts[segment + 1]! - cuts[segment]!));
  const from = path[segment]!;
  const to = path[segment + 1]!;
  const x = Math.round(from.x + (to.x - from.x) * progress);
  const y = Math.round(from.y + (to.y - from.y) * progress);
  const walking = mine ? segment !== 1 && segment !== 2 : segment === 0 || segment === 3;
  const move: readonly [number, number] = walking ? [0, frame % 2 !== 0 ? -1 : 0]
    : command === 'rage' ? [frame % 2 !== 0 ? 1 : -1, (frame >> 1) % 2 !== 0 ? 1 : -2]
      : command === 'carrot' ? [0, frame % 4 < 2 ? -3 : 0]
        : command === 'mine' ? [0, frame % 2 !== 0 ? -1 : 0]
          : [frame % 4 < 2 ? 1 : -1, 0];
  return {
    x, y, dx: move[0], dy: move[1], sprite: walking ? 'walk' : BOSS_ACTION[command], frame: command === 'carrot' || walking ? frame : frame >> 1,
    acting: !walking, mineSeen: mine ? (segment === 0 ? 9999 : segment === 1 ? x : null) : null,
  };
}

function wall(fb: FrameBuffer, room: SceneRoom, night: boolean, f: number, height: number, slots: readonly number[], labels: SceneLabel[], hits: SceneHit[], valve: boolean): void {
  fb.rect(0, 0, 320, 40, 'wall');
  for (let x = 8; x < 320; x += 16) for (let y = 4; y < 38; y += 4) fb.px(x + ((y >> 2) % 2) * 8, y, 'wallSh');
  fb.hl(0, 0, 320, 'wallSh');
  fb.rect(0, 37, 320, 3, 'wallSh');
  fb.rect(0, 40, 320, 8, 'wood');
  fb.hl(0, 40, 320, 'deskFr');
  fb.hl(0, 47, 320, 'woodDk');
  for (let x = 10; x < 320; x += 20) fb.vl(x, 42, 4, 'woodDk');
  for (let row = 0; row * 6 + 48 < height; row += 1) {
    const y = 48 + row * 6;
    fb.rect(0, y, 320, 6, row % 2 !== 0 ? 'floorB' : 'floorA');
    fb.hl(0, y, 320, 'floorSh');
    for (let x = (row * 17) % 40; x < 320; x += 40) fb.vl(x, y, 6, 'floorSh');
  }
  if (!night) {
    for (let y = 48; y < 112; y += 1) fb.shade(86 + Math.round((y - 48) * 0.7), y, 50, 1, SHADE_SUN);
  } else {
    fb.glow(288, 132, 22, SHADE_LIGHT);
    for (const index of slots) fb.glow(DESK_X[index % DESK_COLUMNS]! + 40, DESK_TOP + Math.floor(index / DESK_COLUMNS) * DESK_ROW + 30, 13, SHADE_LIGHT);
  }

  const name = room.name.slice(0, SIGN_MAX_CHARS).toUpperCase();
  const signWidth = Math.max(52, textWidth(name) + 10);
  fb.box(5, 5, signWidth, 21, 'ink', 'woodDk');
  fb.frame(6, 6, signWidth - 2, 19, 'woodDk');
  fb.text(name, 10, 10, 'paper');
  fb.text(room.parent === null ? '-' : `#${room.parent}`, 10, 17, 'accent');

  const window = Math.max(84, 5 + signWidth + 8);
  fb.box(window, 5, 48, 30, 'sky', 'woodDk');
  fb.frame(window + 1, 6, 46, 28, 'wood');
  if (!night) {
    fb.rect(window + 6, 12, 10, 3, 'paper'); fb.rect(window + 9, 10, 5, 2, 'paper'); fb.rect(window + 28, 22, 12, 3, 'cloud'); fb.rect(window + 31, 20, 6, 2, 'cloud');
    for (let g = 0; g < 6; g += 1) { fb.px(window + 4 + g, 30 - g, 'paper'); fb.px(window + 34 + g, 14 - g, 'paper'); }
  } else {
    fb.rect(window + 33, 9, 4, 7, 'paper'); fb.rect(window + 32, 10, 6, 5, 'paper'); fb.rect(window + 35, 8, 4, 6, 'sky'); fb.rect(window + 34, 9, 6, 4, 'sky');
    fb.px(window + 8, 12, 'paper'); fb.px(window + 18, 24, 'cloud'); fb.px(window + 40, 26, 'cloud');
  }
  fb.vl(window + 23, 6, 28, 'wood'); fb.vl(window + 24, 6, 28, 'woodDk'); fb.hl(window + 1, 19, 46, 'wood');
  fb.box(window - 2, 34, 52, 4, 'deskFr');

  const clock = window + 56;
  fb.box(clock, 8, 12, 12, 'paper');
  fb.px(clock, 8, 'wall'); fb.px(clock + 11, 8, 'wall'); fb.px(clock, 19, 'wall'); fb.px(clock + 11, 19, 'wall');
  fb.vl(clock + 5, 11, 4, 'ink');
  const hand = ([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const)[(f >> 3) % 8]!;
  fb.px(clock + 5 + hand[0], 14 + hand[1], 'danger');
  fb.px(clock + 5 + hand[0] * 2, 14 + hand[1] * 2, 'danger');

  // The whiteboard: the plan of the active parent. The advisor owns a new seat limit, so 收放 asks instead of showing a number.
  const plan = room.plan;
  const lines = plan === 'reading' ? ['READING', '', '', '']
    : plan !== null
    ? [plan.revision === null ? 'PLAN' : `PLAN R${plan.revision}`, plan.order.slice(0, BOARD_LINE).join(' '), plan.order.slice(BOARD_LINE, BOARD_LINE * 2).join(' '), valve ? 'SEATS ?' : `SEATS ${plan.limit}`]
    : [room.parent === null ? '' : 'NO PLAN', '', '', ''];
  fb.box(160, 3, 92, 34, 'paper');
  fb.frame(161, 4, 90, 32, 'mist');
  fb.text(lines[0]!, 165, 7, 'ink');
  fb.hl(165, 13, textWidth(lines[0]!), 'accent');
  fb.text(lines[1]!, 165, 16, 'ink');
  fb.text(lines[2]!, 165, 22, 'ink');
  fb.text(lines[3]!, 165, 29, 'slate');
  fb.hl(170, 37, 72, 'slate');
  fb.rect(176, 36, 4, 1, 'danger');
  fb.rect(184, 36, 4, 1, 'codex');
  hits.push({ key: 'board', x: 160, y: 3, width: 92, height: 34 });
  if (room.parent === null) labels.push({ x: 160, y: 13, width: 92, text: room.text.noParent, kind: 'paper' });

  fb.box(256, 20, 20, 3, 'wood');
  ([['slate', 9], ['claudeDk', 8], ['mist', 10], ['woodDk', 7], ['okDk', 9]] as const).forEach(([color, tall], index) => fb.box(258 + index * 3, 20 - tall, 3, tall, color));
}

function stage(fb: FrameBuffer, room: SceneRoom, view: SceneView, labels: SceneLabel[], hits: SceneHit[]): void {
  const f = view.frame;
  const rage = view.effect?.command === 'rage';
  const carrot = view.effect?.command === 'carrot';
  shadow(fb, 88, 49, 150, 48);
  fb.box(88, 49, 150, 40, 'mist');
  fb.frame(90, 51, 146, 36, 'cloud');
  for (let y = 55; y < 85; y += 6) for (let x = 96 + ((y >> 1) % 2) * 6; x < 232; x += 12) fb.px(x, y, 'slate');
  fb.box(88, 88, 150, 9, 'wood');
  fb.hl(89, 89, 148, 'deskFr');
  const seats = [
    { seat: 'orchestrator', who: room.orchestrator, x: 112, phase: 0, busy: rage },
    { seat: 'advisor', who: room.advisor, x: 196, phase: 5, busy: view.advisorBusy || view.effect !== null },
  ] as const;
  for (const { seat, who, x, phase, busy } of seats) {
    const frame = f + phase;
    if (who !== null) {
      const bob = rage ? (frame % 2 !== 0 ? 1 : -1) : carrot ? (frame % 4 < 2 ? -3 : 0) : (frame % 8 < 4 ? -1 : 0);
      const outfit = STAGE_OUTFIT[seat];
      const body = agentBody(who.kind, outfit);
      const top = 47 - body.top;
      const pose: FrontPose = rage ? (frame % 2 !== 0 ? 'panicA' : 'panicB')
        : carrot ? (frame % 4 < 2 ? 'cheerA' : 'cheerB')
          : busy ? (frame % 2 !== 0 ? 'think' : 'front')
            : frame % 24 >= 16 ? (frame % 24 < 20 ? 'sipA' : 'sipB') : (frame % 16 === 0 ? 'blink' : 'front');
      fb.sprite(body.poses[pose], x + body.dx + (rage ? (frame % 2 !== 0 ? 1 : -1) : 0), top + bob, agentPalette(who.kind, outfit));
      badge(fb, who, x + 12, top + body.top + bob);
    }
    deskBody(fb, x - 12, 64, 40);
    fb.box(x + 2, 58, 12, 8, 'ink2');
    fb.px(x + 8, 61, 'mist');
    if (who !== null && busy && frame % 2 !== 0) { fb.px(x + 1, 66, 'skin'); fb.px(x + 15, 66, 'skin'); }
    if (who !== null) hits.push({ key: seat, x: x - 4, y: 44, width: 24, height: 26 });
  }
  labels.push({ x: 100, y: 89, width: 40, text: room.text.orchestrator, kind: 'plaque' });
  labels.push({ x: 184, y: 89, width: 40, text: room.text.advisor, kind: 'plaque' });
}

function ambient(fb: FrameBuffer, room: SceneRoom, night: boolean): void {
  plant(fb, 2, 96, true);
  shadow(fb, 196, 108, 72, 22);
  fb.box(196, 108, 72, 22, 'wallSh');
  fb.frame(198, 110, 68, 18, 'claudeDk');
  fb.frame(200, 112, 64, 14, 'deskFr');
  for (let i = 0; i < 6; i += 1) {
    const x = 206 + i * 10;
    fb.px(x, 119, 'claudeDk'); fb.px(x - 1, 118, 'claudeDk'); fb.px(x + 1, 120, 'claudeDk'); fb.px(x + 1, 118, 'wood'); fb.px(x - 1, 120, 'wood');
  }
  for (let x = 197; x < 267; x += 3) { fb.px(x, 107, 'deskFr'); fb.px(x, 130, 'deskFr'); }
  shadow(fb, 280, 96, 14, 36);
  fb.vl(287, 104, 26, 'ink');
  fb.rect(283, 129, 9, 3, 'ink');
  const lamp = night || !room.lit;
  fb.box(280, 94, 15, 10, lamp ? 'warn' : 'paper');
  fb.hl(281, 95, 13, lamp ? 'paper' : 'cloud');
  plant(fb, 302, 104, false);
}

function effects(fb: FrameBuffer, command: BossEffect, actor: BossActor, f: number, height: number): void {
  if (command === 'rage') {
    const color: PxColor = f % 2 !== 0 ? 'danger' : 'dangerDk';
    for (let inset = 0; inset < 3; inset += 1) fb.frame(inset, inset, 320 - inset * 2, height - inset * 2, color);
    const hx = actor.x + 8;
    const hy = actor.y + 22;
    const radius = 6 + (f % 4) * 9;
    for (let a = 0; a < 48; a += 1) {
      const angle = a / 48 * Math.PI * 2;
      fb.px(Math.round(hx + Math.cos(angle) * radius * 1.6), Math.round(hy + Math.sin(angle) * radius * 0.6), a % 2 !== 0 ? 'woodDk' : 'danger');
    }
    fb.rect(hx - 9, hy - 4 - (f % 3) * 3, 2, 2, 'deskFr');
    fb.rect(hx + 8, hy - 6 - (f % 2) * 4, 2, 2, 'deskFr');
    sign(fb, 'BANG!', actor.x + 18 + (f % 2), actor.y - 2, 'accent', 'ink');
  } else if (command === 'carrot') {
    for (let c = 0; c < 9; c += 1) fb.sprite(CARROT, 14 + c * 35, ((f * 7 + c * 41) % (height + 30)) - 20, CARROT_PALETTE);
    sign(fb, 'PLAN+', 226, 36, 'claudeDk', 'paper');
  } else if (command === 'mine') {
    fb.dashed(1, 1, 318, height - 2, 'warn', f * 2);
    fb.dashed(2, 2, 316, height - 4, 'warn', f * 2);
    sign(fb, 'SCAN R2/R3', 226, 36, 'warnDk', 'paper');
  } else {
    fb.box(176, 41, 103, 6, 'slate');
    fb.hl(177, 42, 101, 'mist');
    for (let b = 0; b < 4; b += 1) fb.rect(178 + ((f * 6 + b * 25) % 98), 43, 3, 2, 'paper');
    sign(fb, 'SEATS ?', 236, 36, 'codexDk', 'paper');
  }
}

/** The room on the framebuffer, with the label, tag and hit layers in grid units. */
export function composeRoom(room: SceneRoom, view: SceneView): ComposedScene {
  const f = view.frame;
  const { night } = view;
  const effect = view.effect?.command ?? null;
  const slots = Math.ceil(Math.max(8, room.limit, room.desks.length) / DESK_COLUMNS) * DESK_COLUMNS;
  const rows = slots / DESK_COLUMNS;
  const height = BASE_HEIGHT + (rows - 2) * DESK_ROW;
  const fb = new FrameBuffer(320, height);
  const labels: SceneLabel[] = [];
  const deskLabels: SceneDeskLabel[] = [];
  const hits: SceneHit[] = [];
  const tags: SceneTag[] = [];
  const actor = view.effect === null ? null : bossActor(view.effect.command, view.effect.elapsedMs, f);

  const glowing = room.desks.flatMap((desk, index) => (desk.state === 'coding' || desk.state === 'ci_failed' ? [index] : []));
  wall(fb, room, night, f, height, glowing, labels, hits, effect === 'valve');

  door(fb, 281, 3, room.mergeWait, room.mergeWait === 'off' && effect === null, f);
  hits.push({ key: 'door', x: 279, y: 1, width: 36, height: 47 });

  deskBody(fb, 8, 62, 44);
  for (let paper = 0; paper < Math.min(room.tray, 3); paper += 1) {
    fb.box(14 + paper * 6, 60 - paper * 2, 14, 9, 'paper');
    fb.hl(16 + paper * 6, 62 - paper * 2, 8, 'mist');
  }
  labels.push({ x: 8, y: 81, text: room.text.tray, kind: 'plain' });
  hits.push({ key: 'tray', x: 6, y: 54, width: 48, height: 26 });

  stage(fb, room, view, labels, hits);

  ambient(fb, room, night);

  fb.dashed(56, 102, 128, 32, 'warn', 0);
  fb.dashed(57, 103, 126, 30, 'warn', 0);
  labels.push({ x: 59, y: 105, text: room.text.queue, kind: 'plain' });
  // The zone hit comes first, so the entries it lists stay on top of it.
  const overflow = room.queue.length - QUEUE_X.length;
  if (overflow > 0) {
    labels.push({ x: 59, y: 122, text: `+${overflow}`, kind: 'plain' });
    hits.push({ key: 'queue', x: 56, y: 102, width: 128, height: 32 });
  }
  room.queue.slice(0, QUEUE_X.length).forEach((entry, index) => {
    const x = QUEUE_X[index]!;
    const frame = f + index;
    const rage = effect === 'rage';
    const carrot = effect === 'carrot';
    const pose: FrontPose | null = rage ? (frame % 2 !== 0 ? 'panicA' : 'panicB') : carrot ? (frame % 4 < 2 ? 'cheerA' : 'cheerB') : frame % 12 >= 8 ? (frame % 2 !== 0 ? 'waveA' : 'waveB') : null;
    queuer(fb, x, 106, entry.agent, String(entry.pr), frame, rage ? (frame % 2 !== 0 ? 1 : -1) : 0, rage ? 0 : carrot ? (frame % 4 < 2 ? -3 : 0) : (frame % 2 !== 0 ? -1 : 0), queueOutfit(index), pose);
    hits.push({ key: entry.key, x: x - 2, y: 96, width: 20, height: 35 });
  });

  for (let index = 0; index < slots; index += 1) {
    const desk = room.desks[index];
    const x = DESK_X[index % DESK_COLUMNS]!;
    const y = DESK_TOP + Math.floor(index / DESK_COLUMNS) * DESK_ROW;
    if (desk === undefined) {
      const roped = index >= room.limit;
      deskCell(fb, x, y, { kind: roped ? 'roped' : 'empty', screen: 'off' }, f + index);
      deskLabels.push({ x: x + 12, y: y + 44, number: room.text.seat(index), text: roped ? room.text.roped : room.text.free, tone: 'subtle', dim: roped });
      continue;
    }
    const cell = seatedCell(desk.state, desk.agent, deskOutfit(index), index, f, effect);
    deskCell(fb, x, y, cell, f + index);
    if (effect === 'rage' && cell.kind === 'worker') {
      for (let puff = 0; puff < 2; puff += 1) {
        const py = y + 30 - ((f + puff * 3) % 5) * 2;
        const px = puff !== 0 ? x + 50 : x + 27;
        fb.frame(px - 1, py - 1, 5, 4, 'cloud');
        fb.rect(px, py, 3, 2, 'paper');
      }
    }
    deskLabels.push({ x: x + 12, y: y + 44, number: desk.number, text: desk.label, tone: STATE_TONE[desk.state], dim: false });
    hits.push({ key: desk.key, x: x + 12, y, width: 58, height: 44 });
    const rule = effect === 'mine' ? room.mines.get(desk.key) : undefined;
    if (rule !== undefined && (actor!.mineSeen === null || actor!.mineSeen <= x + 40)) {
      const color: PxColor = f % 2 !== 0 ? 'warn' : 'warnDk';
      fb.frame(x + 8, y - 1, 66, 46, color);
      fb.frame(x + 9, y, 64, 44, color);
      tags.push({ x: x + 9, y: y + 1, text: room.text.mine(rule), tone: 'mine' });
    }
  }

  if (actor !== null && effect !== null) {
    fb.shade(actor.x + 2, actor.y + 20, 13, 2, SHADE_DARK);
    fb.sprite(BOSS[actor.sprite][actor.frame % 2]!, actor.x + actor.dx, actor.y + actor.dy, BOSS_PALETTE);
    const say = room.text.say(effect);
    if (actor.acting && say !== '') tags.push({ x: actor.x + 14, y: actor.y - 6, text: say, tone: 'speech' });
    effects(fb, effect, actor, f, height);
  }
  return { width: 320, height, paths: fb.paths(), labels, deskLabels, hits, tags };
}

export interface SceneMiniRoom {
  readonly orchestrator: SceneAgent | null;
  readonly advisor: SceneAgent | null;
  readonly plan: boolean;
  readonly needsYou: boolean;
  readonly desks: readonly { readonly agent: SceneAgent; readonly state: DeskState }[];
  /** The worker limit that sets the roped desks; null when no summary sent one. */
  readonly limit: number | null;
  /** The queue count; the summary names no agent, so each figure is an unknown agent. */
  readonly queue: number;
  readonly idle: boolean;
}

const MINI_WIDTH = 112;
const MINI_HEIGHT = 72;
const MINI_DESK_X = [2, 30, 58, 86] as const;
const MINI_DESK_Y = [42, 57] as const;
const MINI_DESKS = MINI_DESK_X.length * MINI_DESK_Y.length;
const MINI_QUEUE = 4;
const MINI_SCREEN: Partial<Readonly<Record<DeskState, PxColor>>> = { coding: 'screen', ci_failed: 'danger', error: 'danger', done: 'ok' };
const MINI_LAMP: Partial<Readonly<Record<DeskState, PxColor>>> = { ci_pending: 'screen', ci_failed: 'danger', blocked: 'warn' };
const MINI_MARK: Partial<Readonly<Record<DeskState, readonly [string, PxColor]>>> = { no_claim_status: ['Z', 'warnDk'], blocked: ['!', 'warnDk'], error: ['!', 'danger'] };
const MINI_DIM: PxMap = { floorA: 'floorSh', floorB: 'floorSh', wall: 'wallSh', wood: 'woodDk', deskTop: 'deskFr', deskFr: 'wood', mist: 'slate', cloud: 'mist', paper: 'cloud', slate: 'ink2' };

function miniLead(fb: FrameBuffer, agent: SceneAgent | null, x: number, f: number): void {
  if (agent !== null) fb.sprite(miniAgent(agent.kind, 'front'), x, 13 + (f % 6 < 3 ? -1 : 0), agentPalette(agent.kind, 'plain'));
  fb.box(x - 2, 20, 11, 4, 'deskTop');
}

function miniDesk(fb: FrameBuffer, desk: SceneMiniRoom['desks'][number] | undefined, index: number, limit: number | null, f: number): void {
  const x = MINI_DESK_X[index % MINI_DESK_X.length]!;
  const y = MINI_DESK_Y[index < MINI_DESK_X.length ? 0 : 1]!;
  const state = desk?.state;
  const coding = state === 'coding';
  const failed = state === 'ci_failed';
  const away = state === 'acceptance_queue';
  const roped = desk === undefined && limit !== null && index >= limit;
  const lamp = state === undefined ? undefined : MINI_LAMP[state];
  if (lamp !== undefined) {
    fb.box(x + 1, y + 1, 4, 8, 'ink2');
    fb.px(x + 2, y + 3, (!failed && state !== 'blocked') || f % 2 !== 0 ? lamp : 'ink');
  }
  shadow(fb, x + 5, y + 6, 20, 6);
  fb.box(x + 10, y, 9, 7, 'ink2');
  fb.rect(x + 11, y + 1, 7, 4, (state === undefined ? undefined : MINI_SCREEN[state]) ?? 'ink');
  if (coding) fb.hl(x + 12, y + 2, 2 + (f + index) % 4, 'paper');
  fb.box(x + 5, y + 6, 20, 4, 'deskTop');
  fb.box(x + 5, y + 9, 20, 3, 'deskFr');
  if (desk !== undefined && !away) {
    const dx = failed ? ((f + index) % 2 !== 0 ? 1 : -1) : 0;
    fb.sprite(miniAgent(desk.agent.kind, 'back'), x + 11 + dx, y + 8 + (coding && (f + index) % 2 !== 0 ? -1 : 0), agentPalette(desk.agent.kind, 'plain'));
    const mark = state === undefined ? undefined : MINI_MARK[state];
    if (mark !== undefined) fb.text(mark[0], x + 20, y - 1 + ((f >> 1) % 2), mark[1]);
  } else if (!roped) fb.box(x + 11, y + 11, 7, 3, 'slate');
  if (away) fb.box(x + 19, y + 4, 4, 3, 'paper');
  if (roped) {
    fb.rect(x + 9, y, 11, 8, 'cloud'); fb.frame(x + 9, y, 11, 8, 'mist');
    fb.rect(x + 4, y + 6, 22, 4, 'cloud'); fb.frame(x + 4, y + 6, 22, 4, 'mist');
    fb.vl(x + 3, y + 9, 5, 'ink2'); fb.vl(x + 26, y + 9, 5, 'ink2');
    fb.hl(x + 4, y + 11, 22, 'dangerDk');
  }
}

/** One repository as a mini room on a 112x72 grid, after the overview page of the S0 mockup. */
export function composeMiniRoom(room: SceneMiniRoom, { frame: f, night }: Pick<SceneView, 'frame' | 'night'>): readonly ScenePath[] {
  const fb = new FrameBuffer(MINI_WIDTH, MINI_HEIGHT);
  fb.rect(0, 0, MINI_WIDTH, 12, 'wall');
  fb.hl(0, 0, MINI_WIDTH, 'wallSh');
  fb.rect(0, 12, MINI_WIDTH, 3, 'wood');
  fb.hl(0, 14, MINI_WIDTH, 'woodDk');
  for (let row = 0; row * 4 + 15 < MINI_HEIGHT; row += 1) {
    const y = 15 + row * 4;
    fb.rect(0, y, MINI_WIDTH, 4, row % 2 !== 0 ? 'floorB' : 'floorA');
    fb.hl(0, y, MINI_WIDTH, 'floorSh');
    for (let x = (row * 11) % 24; x < MINI_WIDTH; x += 24) fb.vl(x, y, 4, 'floorSh');
  }
  if (night) fb.glow(104, 50, 10, SHADE_LIGHT);
  fb.box(5, 2, 14, 9, 'sky', 'woodDk');
  fb.vl(11, 3, 7, 'wood');
  fb.hl(6, 6, 12, 'wood');
  if (night) fb.px(15, 4, 'paper'); else fb.px(7, 9, 'paper');
  if (room.plan) { fb.box(42, 1, 28, 10, 'paper'); fb.hl(45, 4, 14, 'ink'); fb.hl(45, 7, 19, 'slate'); }
  if (room.needsYou) { fb.frame(94, 0, 16, 15, 'accent'); fb.box(86, 1, 5, 7, 'accent'); fb.vl(88, 2, 3, 'ink'); fb.px(88, 6, 'ink'); }
  fb.box(96, 1, 12, 14, 'wood');
  fb.box(98, 3, 8, 3, 'ink2', 'ink2');
  fb.px(105, 9, 'warn');
  shadow(fb, 32, 16, 48, 12);
  fb.box(32, 16, 48, 10, 'mist');
  fb.box(32, 25, 48, 3, 'wood');
  miniLead(fb, room.orchestrator, 42, f);
  miniLead(fb, room.advisor, 63, f + 3);
  fb.dashed(20, 29, 44, 12, 'warn', 0);
  for (let index = 0; index < Math.min(room.queue, MINI_QUEUE); index += 1) fb.sprite(miniAgent('unknown', 'front'), 52 - index * 10, 31 + ((f + index) % 2 !== 0 ? -1 : 0), agentPalette('unknown', 'plain'));
  fb.box(102, 40, 7, 4, night ? 'warn' : 'paper');
  fb.vl(105, 44, 6, 'ink');
  for (let index = 0; index < MINI_DESKS; index += 1) miniDesk(fb, room.desks[index], index, room.limit, f);
  if (room.idle) {
    fb.shade(0, 0, MINI_WIDTH, MINI_HEIGHT, MINI_DIM);
    fb.box(102, 40, 7, 4, 'warn');
  }
  return fb.paths();
}
