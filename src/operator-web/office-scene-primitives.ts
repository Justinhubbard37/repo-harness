import type { AdvisorBossCommand } from '../core/board/advisor-seat';
import type { BoardAcceptanceMergeV1 } from '../core/board/board';
import type { DeskState } from '../core/board/desk';
import {
  agentBody, agentPalette, agentTagColor, BOSS, BOSS_PALETTE, CHAIR, CHAIR_PALETTE, glyph, PX_COLORS, SHADE_DARK, textWidth,
  type BossPose, type FrontPose, type Outfit, type Pose, type PxColor, type PxMap, type SceneAgent, type Sprite, type SpritePalette,
} from './office-sprites';

/**
 * The office room on one indexed framebuffer, after the approved S0 mockup
 * (#1790 M82): a 320x240 grid drawn at an integer scale, one SVG path per
 * palette token. The grid grows one desk row at a time past 8 desks. Text
 * outside the sign font stays in the label layers, in the console font.
 */
export interface ScenePath {
  readonly d: string;
  readonly color: PxColor;
}

export class FrameBuffer {
  private readonly cells: Uint8Array;

  constructor(readonly width: number, readonly height: number) {
    this.cells = new Uint8Array(width * height);
  }

  px(x: number, y: number, color: PxColor | null): void {
    if (color === null || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.cells[y * this.width + x] = PX_COLORS.indexOf(color) + 1;
  }

  private at(x: number, y: number): PxColor | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return PX_COLORS[this.cells[y * this.width + x]! - 1] ?? null;
  }

  rect(x: number, y: number, width: number, height: number, color: PxColor): void {
    for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) this.px(x + column, y + row, color);
  }

  hl(x: number, y: number, width: number, color: PxColor): void { this.rect(x, y, width, 1, color); }
  vl(x: number, y: number, height: number, color: PxColor): void { this.rect(x, y, 1, height, color); }

  frame(x: number, y: number, width: number, height: number, color: PxColor): void {
    this.hl(x, y, width, color); this.hl(x, y + height - 1, width, color); this.vl(x, y, height, color); this.vl(x + width - 1, y, height, color);
  }

  box(x: number, y: number, width: number, height: number, fill: PxColor, line: PxColor = 'ink'): void {
    this.rect(x, y, width, height, fill);
    this.frame(x, y, width, height, line);
  }

  dashed(x: number, y: number, width: number, height: number, color: PxColor, phase: number): void {
    for (let i = 0; i < width; i += 1) if (((i + phase) >> 1) % 2 === 0) { this.px(x + i, y, color); this.px(x + width - 1 - i, y + height - 1, color); }
    for (let j = 0; j < height; j += 1) if (((j + phase) >> 1) % 2 === 0) { this.px(x + width - 1, y + j, color); this.px(x, y + height - 1 - j, color); }
  }

  shade(x: number, y: number, width: number, height: number, map: PxMap): void {
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const color = this.at(x + column, y + row);
        if (color !== null && map[color] !== undefined) this.px(x + column, y + row, map[color]!);
      }
    }
  }

  /** A dithered pool of light: full inside 0.65 of the radius, a checkerboard to the radius. */
  glow(centerX: number, centerY: number, radius: number, map: PxMap): void {
    for (let y = centerY - radius; y <= centerY + radius; y += 1) {
      for (let x = centerX - radius * 2; x <= centerX + radius * 2; x += 1) {
        const distance = Math.sqrt(((x - centerX) / 2) ** 2 + (y - centerY) ** 2) / radius;
        if (distance > 1 || (distance > 0.65 && (x + y) % 2 !== 0)) continue;
        const color = this.at(x, y);
        if (color !== null && map[color] !== undefined) this.px(x, y, map[color]!);
      }
    }
  }

  sprite(rows: Sprite, x: number, y: number, palette: SpritePalette): void {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i += 1) {
        const color = palette[row[i]!];
        if (row[i] !== '.' && color !== undefined) this.px(x + i, y + j, color);
      }
    });
  }

  text(text: string, x: number, y: number, color: PxColor): void {
    let cursor = x;
    for (const char of text.toUpperCase()) {
      const bits = glyph(char);
      const width = bits.length / 5;
      for (let bit = 0; bit < bits.length; bit += 1) if (bits[bit] === '1') this.px(cursor + (bit % width), y + Math.floor(bit / width), color);
      cursor += width + 1;
    }
  }

  paths(): readonly ScenePath[] {
    const runs = new Map<number, string[]>();
    for (let y = 0; y < this.height; y += 1) {
      let x = 0;
      while (x < this.width) {
        const value = this.cells[y * this.width + x]!;
        if (value === 0) { x += 1; continue; }
        const start = x;
        while (x < this.width && this.cells[y * this.width + x] === value) x += 1;
        const run = `M${start} ${y}h${x - start}v1h-${x - start}z`;
        const list = runs.get(value);
        if (list === undefined) runs.set(value, [run]); else list.push(run);
      }
    }
    return [...runs].map(([value, list]) => ({ d: list.join(''), color: PX_COLORS[value - 1]! }));
  }
}

export const shadow = (fb: FrameBuffer, x: number, y: number, width: number, height: number) => fb.shade(x + 2, y + 2, width, height, SHADE_DARK);

export function badge(fb: FrameBuffer, agent: SceneAgent, x: number, y: number): void {
  const width = textWidth(agent.badge) + 4;
  const tag = agentTagColor(agent.kind);
  if (tag !== null) {
    fb.box(x, y, width, 7, tag);
    fb.text(agent.badge, x + 2, y + 1, 'paper');
  } else {
    fb.rect(x, y, width, 7, 'paper');
    fb.dashed(x, y, width, 7, 'slate', 0);
    fb.text(agent.badge, x + 2, y + 1, 'slate');
  }
}

export function sign(fb: FrameBuffer, text: string, x: number, y: number, foreground: PxColor, background: PxColor): void {
  fb.box(x, y, textWidth(text) + 4, 9, background);
  fb.text(text, x + 2, y + 2, foreground);
}

type BubbleGlyph = 'dots' | 'x' | 'check' | string;

function bubble(fb: FrameBuffer, x: number, y: number, mark: BubbleGlyph, color: PxColor, f: number): void {
  fb.box(x, y, 17, 11, 'paper');
  fb.px(x + 3, y + 11, 'ink'); fb.px(x + 4, y + 11, 'ink'); fb.px(x + 3, y + 12, 'ink');
  if (mark === 'dots') {
    for (let i = 0; i < 1 + (f % 3); i += 1) fb.rect(x + 4 + i * 4, y + 5, 2, 2, color);
  } else if (mark === 'x') {
    for (let k = 0; k < 5; k += 1) { fb.px(x + 6 + k, y + 3 + k, color); fb.px(x + 10 - k, y + 3 + k, color); fb.px(x + 7 + k, y + 3 + k, color); fb.px(x + 11 - k, y + 3 + k, color); }
  } else if (mark === 'check') {
    for (let k = 0; k < 3; k += 1) { fb.px(x + 5 + k, y + 5 + k, color); fb.px(x + 6 + k, y + 5 + k, color); }
    for (let k = 0; k < 5; k += 1) { fb.px(x + 8 + k, y + 7 - k, color); fb.px(x + 9 + k, y + 7 - k, color); }
  } else fb.text(mark, x + Math.floor((17 - textWidth(mark)) / 2), y + 3, color);
}

type Screen = 'coding' | 'ci_pending' | 'ci_failed' | 'error' | 'stalled' | 'off';

function monitor(fb: FrameBuffer, x: number, y: number, screen: Screen, f: number, seed: number): void {
  fb.box(x, y, 20, 14, 'ink2');
  const sx = x + 2;
  const sy = y + 2;
  if (screen === 'coding') {
    fb.rect(sx, sy, 16, 10, 'screen');
    const lengths = [9, 5, 12, 7, 10, 4, 11, 6];
    for (let line = 0; line < 4; line += 1) {
      const width = lengths[(line + (f >> 1) + seed) % lengths.length]!;
      fb.hl(sx + 2 + (line % 2) * 2, sy + 1 + line * 2, width - (line % 2) * 2, line === 0 ? 'paper' : 'cloud');
    }
    if (f % 2 !== 0) fb.rect(sx + 13, sy + 7, 2, 2, 'paper');
    fb.px(sx, sy, 'paper');
  } else if (screen === 'ci_pending') {
    fb.rect(sx, sy, 16, 10, 'ink');
    fb.frame(sx + 2, sy + 4, 12, 3, 'mist');
    fb.hl(sx + 3, sy + 5, 1 + (f % 10), 'screen');
    fb.px(sx, sy, 'slate');
  } else if (screen === 'ci_failed') {
    fb.rect(sx, sy, 16, 10, f % 4 === 3 ? 'dangerDk' : 'danger');
    for (let k = 0; k < 6; k += 1) { fb.px(sx + 5 + k, sy + 2 + k, 'paper'); fb.px(sx + 10 - k, sy + 2 + k, 'paper'); }
    fb.px(sx, sy, 'paper');
  } else if (screen === 'error') {
    fb.rect(sx, sy, 16, 10, 'danger');
    fb.rect(sx + 7, sy + 2, 2, 4, 'paper');
    fb.rect(sx + 7, sy + 7, 2, 1, 'paper');
    fb.px(sx, sy, 'paper');
  } else {
    fb.rect(sx, sy, 16, 10, 'ink');
    fb.px(sx + 1, sy + 1, 'slate'); fb.px(sx + 2, sy + 1, 'slate'); fb.px(sx + 1, sy + 2, 'slate');
    if (screen === 'stalled' && f % 4 < 2) fb.px(sx + 14, sy + 8, 'warn');
  }
  fb.rect(x + 8, y + 14, 4, 2, 'ink');
  fb.rect(x + 6, y + 16, 8, 1, 'ink');
}

export function deskBody(fb: FrameBuffer, x: number, y: number, width: number): void {
  shadow(fb, x, y, width, 17);
  fb.box(x, y, width, 10, 'deskTop');
  fb.hl(x + 1, y + 1, width - 2, 'paper');
  fb.box(x, y + 9, width, 8, 'deskFr');
  fb.hl(x + 1, y + 15, width - 2, 'wood');
  fb.rect(x + Math.floor(width / 2) - 5, y + 11, 10, 1, 'wood');
}

function ciTower(fb: FrameBuffer, x: number, y: number, lamp: PxColor, f: number, blink: boolean): void {
  shadow(fb, x, y, 10, 26);
  fb.box(x, y, 10, 26, 'ink2');
  fb.text('CI', x + 2, y + 2, 'paper');
  fb.hl(x + 2, y + 9, 6, 'slate'); fb.hl(x + 2, y + 21, 6, 'slate'); fb.hl(x + 2, y + 23, 6, 'slate');
  const on = !blink || f % 2 === 0;
  fb.box(x + 2, y + 12, 6, 6, on ? lamp : 'ink');
  if (on) fb.px(x + 3, y + 13, 'paper');
}

function mug(fb: FrameBuffer, x: number, y: number, f: number): void {
  fb.box(x, y, 5, 5, 'paper');
  fb.px(x + 5, y + 2, 'ink'); fb.px(x + 1, y + 1, 'claudeDk');
  const puff = f % 3;
  fb.px(x + 1 + (puff === 1 ? 1 : 0), y - 2 - puff, 'cloud');
  fb.px(x + 3 - (puff === 2 ? 1 : 0), y - 4 + (puff === 0 ? 1 : 0), 'cloud');
}

export function plant(fb: FrameBuffer, x: number, y: number, tall: boolean): void {
  const height = tall ? 22 : 12;
  shadow(fb, x + 2, y + height, 10, 9);
  for (let i = 0; i < height; i += 3) {
    const band = (i / 3) % 2;
    const spread = tall ? 3 + band * 3 : 4;
    fb.rect(x + 7 - spread, y + i, spread * 2 + 1, 3, band !== 0 ? 'okDk' : 'leaf');
    fb.px(x + 7 - spread, y + i, 'ink'); fb.px(x + 7 + spread, y + i, 'ink');
  }
  fb.px(x + 6, y - 1, 'leaf'); fb.px(x + 8, y - 1, 'leaf');
  fb.box(x + 2, y + height, 11, 9, 'claudeDk');
  fb.hl(x + 3, y + height + 1, 9, 'claude');
}

interface DeskCell {
  readonly kind: 'worker' | 'away' | 'empty' | 'roped';
  readonly screen: Screen;
  readonly agent?: SceneAgent;
  readonly outfit?: Outfit;
  readonly lamp?: PxColor;
  readonly blink?: boolean;
  readonly bubble?: BubbleGlyph;
  readonly bubbleColor?: PxColor;
  readonly seed?: number;
  readonly typing?: boolean;
  readonly mug?: boolean;
  readonly act?: 'sip' | 'panic' | 'cheer';
  readonly slump?: boolean;
  readonly dx?: number;
  readonly bob?: number;
}

export function deskCell(fb: FrameBuffer, x: number, y: number, cell: DeskCell, f: number): void {
  if (cell.lamp !== undefined) ciTower(fb, x + 3, y + 6, cell.lamp, f, cell.blink === true);
  deskBody(fb, x + 14, y + 16, 52);
  monitor(fb, x + 30, y + 2, cell.screen, f, cell.seed ?? 0);
  fb.rect(x + 33, y + 20, 14, 2, 'mist');
  fb.hl(x + 33, y + 22, 14, 'slate');
  if (cell.mug === true) mug(fb, x + 19, y + 17, f);
  if (cell.kind === 'worker') {
    const agent = cell.agent!;
    const outfit = cell.outfit!;
    const body = agentBody(agent.kind, outfit);
    const palette = agentPalette(agent.kind, outfit);
    const dx = cell.dx ?? 0;
    const bob = cell.bob ?? 0;
    const acted: Pose = cell.act === 'sip' ? (f % 8 >= 5 ? 'backSip' : 'back')
      : cell.act === 'panic' ? (f % 2 !== 0 ? 'backUpA' : 'backUpB')
        : cell.act === 'cheer' ? (f % 4 < 2 ? 'backUpA' : 'back') : 'back';
    const rows = body.poses[cell.typing === true ? (f % 2 !== 0 ? 'backType' : 'back') : acted];
    const bodyX = x + 32 + body.dx;
    if (cell.slump === true) {
      fb.sprite(rows.slice(11), bodyX, y + 31, palette);
      fb.sprite(rows.slice(0, 11), bodyX, y + 23, palette);
    } else fb.sprite(rows, bodyX + dx, y + 20 + bob, palette);
    fb.sprite(CHAIR, x + 31, y + 33, CHAIR_PALETTE);
    badge(fb, agent, x + 46 + dx, y + 18 + body.topBack + bob);
  } else if (cell.kind === 'away') {
    fb.box(x + 50, y + 18, 9, 6, 'paper');
    fb.hl(x + 52, y + 20, 4, 'warnDk'); fb.px(x + 55, y + 19, 'warnDk'); fb.px(x + 55, y + 21, 'warnDk');
    fb.sprite(CHAIR, x + 40, y + 36, CHAIR_PALETTE);
  } else if (cell.kind === 'empty') {
    fb.sprite(CHAIR, x + 31, y + 30, CHAIR_PALETTE);
  } else {
    fb.rect(x + 27, y + 1, 26, 16, 'cloud'); fb.frame(x + 27, y + 1, 26, 16, 'ink');
    fb.rect(x + 13, y + 14, 54, 6, 'cloud'); fb.frame(x + 13, y + 14, 54, 6, 'ink');
    fb.hl(x + 28, y + 3, 20, 'paper'); fb.vl(x + 33, y + 4, 9, 'mist'); fb.vl(x + 45, y + 4, 9, 'mist');
    for (let r = 0; r < 54; r += 4) fb.px(x + 13 + r, y + 20, 'mist');
    fb.box(x + 10, y + 26, 3, 15, 'ink2'); fb.rect(x + 9, y + 25, 5, 2, 'warn');
    fb.box(x + 67, y + 26, 3, 15, 'ink2'); fb.rect(x + 66, y + 25, 5, 2, 'warn');
    for (let q = 0; q < 54; q += 1) fb.px(x + 13 + q, y + 29 + Math.round(3 * Math.sin(Math.PI * q / 54)), 'dangerDk');
  }
  if (cell.bubble !== undefined) bubble(fb, x + 52, y, cell.bubble, cell.bubbleColor!, f);
}

/** The door colour while a pull request waits. Only `off` waits for you, so only `off` has the boss behind the door. */
const DOOR_MARK: Readonly<Record<BoardAcceptanceMergeV1, PxColor>> = { off: 'accent', on: 'ok', unknown: 'warn' };

export function door(fb: FrameBuffer, x: number, y: number, wait: BoardAcceptanceMergeV1 | null, peek: boolean, f: number): void {
  if (wait !== null) {
    const color = DOOR_MARK[wait];
    fb.frame(x - 2, y - 2, 36, 47, color); fb.frame(x - 1, y - 1, 34, 46, color);
    sign(fb, '!', x - 15, y + 1, 'ink', color);
  }
  fb.box(x, y, 32, 45, 'woodDk');
  const left = peek ? x + 10 : x + 3;
  const width = x + 29 - left;
  if (peek) {
    fb.rect(x + 3, y + 3, 8, 41, 'ink');
    fb.sprite(BOSS.worried[(f >> 1) % 2]!, x - 1, y + 19, BOSS_PALETTE);
    fb.rect(x, y + 19, 3, 25, 'woodDk');
  }
  fb.box(left, y + 3, width, 42, 'wood');
  fb.frame(left + 3, y + 17, width - 6, 10, 'woodDk');
  fb.frame(left + 3, y + 30, width - 6, 11, 'woodDk');
  const plate = left + Math.floor((width - 19) / 2);
  fb.box(plate, y + 6, 19, 9, 'ink2');
  fb.text('MAIN', plate + 2, y + 8, 'paper');
  fb.rect(x + 24, y + 27, 2, 2, 'warn');
}

export function queuer(fb: FrameBuffer, x: number, y: number, agent: SceneAgent, ticket: string, f: number, dx: number, bob: number, outfit: Outfit, pose: FrontPose | null): void {
  fb.shade(x + 2, y + 23, 13, 2, SHADE_DARK);
  const body = agentBody(agent.kind, outfit);
  fb.sprite(body.poses[pose ?? (f % 2 !== 0 ? 'step' : 'front')], x + dx + body.dx, y + bob, agentPalette(agent.kind, outfit));
  badge(fb, agent, x + 12 + dx, y + body.top + bob);
  sign(fb, ticket, x + 8 - Math.floor((textWidth(ticket) + 4) / 2), y + body.top - 10 - body.hat + bob, 'ink', 'paper');
}

/** The desk states of a seat: the screen, the CI lamp, the bubble and the seated action. */
function deskLook(state: DeskState): Pick<DeskCell, 'screen' | 'lamp' | 'blink' | 'bubble' | 'bubbleColor'> {
  switch (state) {
    case 'blocked': return { screen: 'stalled', lamp: 'warn', blink: true, bubble: '!', bubbleColor: 'warnDk' };
    case 'error': return { screen: 'error', bubble: '!', bubbleColor: 'danger' };
    case 'done': return { screen: 'off', bubble: 'check', bubbleColor: 'ok' };
    case 'coding': return { screen: 'coding', bubble: 'dots', bubbleColor: 'codex' };
    case 'ci_pending': return { screen: 'ci_pending', lamp: 'screen', bubble: 'CI', bubbleColor: 'codexDk' };
    case 'ci_failed': return { screen: 'ci_failed', lamp: 'danger', blink: true, bubble: 'x', bubbleColor: 'danger' };
    case 'no_claim_status': return { screen: 'stalled', bubble: 'ZZ', bubbleColor: 'warnDk' };
    case 'unknown': return { screen: 'off', bubble: '?', bubbleColor: 'slate' };
    default: return { screen: 'off' };
  }
}

/** One desk state on its own small grid, for the legend. */
export function deskVignette(state: DeskState | 'empty', agent: SceneAgent, f: number): { readonly width: number; readonly height: number; readonly paths: readonly ScenePath[] } {
  const fb = new FrameBuffer(80, 46);
  for (let row = 0; row < 8; row += 1) fb.rect(0, row * 6, 80, 6, row % 2 !== 0 ? 'floorB' : 'floorA');
  deskCell(fb, 0, 0, seatedCell(state, agent, 'cap', 0, f, null), f);
  return { width: 80, height: 46, paths: fb.paths() };
}

export function seatedCell(state: DeskState | 'empty', agent: SceneAgent, outfit: Outfit, index: number, f: number, effect: AdvisorBossCommand | null): DeskCell {
  if (state === 'empty') return { kind: 'empty', screen: 'off' };
  if (state === 'acceptance_queue') return { kind: 'away', screen: 'off' };
  const frame = f + index * 3;
  const rage = effect === 'rage';
  const carrot = effect === 'carrot';
  const cell: DeskCell = {
    ...deskLook(state), kind: 'worker', agent, outfit, seed: index, typing: state === 'coding' || rage, mug: state === 'coding',
    slump: state === 'no_claim_status' && !rage && !carrot,
    ...(carrot ? { act: 'cheer' as const } : state === 'ci_pending' ? { act: 'sip' as const } : state === 'ci_failed' ? { act: 'panic' as const } : {}),
  };
  if (rage) return { ...cell, dx: frame % 2 !== 0 ? 1 : -1, bubble: '!!', bubbleColor: 'danger' };
  if (carrot) return { ...cell, bob: frame % 4 < 2 ? -3 : 0, bubble: '+1', bubbleColor: 'woodDk' };
  if (state === 'ci_failed') return { ...cell, dx: frame % 4 === 0 ? 1 : (frame % 4 === 2 ? -1 : 0) };
  if (state === 'ci_pending') return { ...cell, dx: frame % 8 < 4 ? 1 : 0 };
  return cell;
}

/** A front sprite with its badge on a 26x26 grid, for the side panel. */
export function agentPortrait(agent: SceneAgent, outfit: Outfit, f: number): readonly ScenePath[] {
  const fb = new FrameBuffer(26, 26);
  const body = agentBody(agent.kind, outfit);
  const y = 2 - Math.floor((body.top - 1) / 2);
  fb.sprite(body.poses[f % 16 === 0 ? 'blink' : 'front'], 2 + body.dx, y, agentPalette(agent.kind, outfit));
  badge(fb, agent, 14, y + body.top - 2);
  return fb.paths();
}

export function bossPortrait(pose: BossPose, f: number): readonly ScenePath[] {
  const fb = new FrameBuffer(16, 22);
  fb.sprite(BOSS[pose][f % 2]!, 0, 0, BOSS_PALETTE);
  return fb.paths();
}
