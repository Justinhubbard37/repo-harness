import { connect } from 'node:net';
import { PI_CODEX_MODEL_PREFIX } from '../../core/board/seats-settings';
import { GENERIC_REVIEW_ROLE } from '../../core/review/acceptance-receipt';
import { AGENT_TARGET_OVERRIDES } from '../terminal/task-role-profiles';

/**
 * The local magpie gateway (#2764). A sandboxed review child holds no credential: each model call
 * goes to magpie on loopback with the placeholder key, and magpie holds the real credential. The pi
 * and codex review configurations are generated from these constants alone; nothing overrides them.
 */
export const MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1';
export const MAGPIE_PORT = Number(new URL(MAGPIE_BASE_URL).port);
export const MAGPIE_PLACEHOLDER_KEY = 'magpie';
export const MAGPIE_PI_API = 'openai-completions';
export const MAGPIE_CODEX_WIRE_API = 'responses';
export const MAGPIE_ACTOR_HEADER = 'x-openai-actor-authorization';

const reviewTarget = AGENT_TARGET_OVERRIDES[GENERIC_REVIEW_ROLE]!;
/** The pi provider name of magpie: the first segment of the `magpie/codex/` seat model prefix. */
export const MAGPIE_PROVIDER = PI_CODEX_MODEL_PREFIX.slice(0, PI_CODEX_MODEL_PREFIX.indexOf('/'));
/** The pi `--model` reference of the review role, composed like the pi fleet role models. */
export const MAGPIE_REVIEW_PI_MODEL = `${PI_CODEX_MODEL_PREFIX}${reviewTarget.model}`;
/** The magpie model id of the review role (`codex/<target model>`). */
export const MAGPIE_REVIEW_MODEL = MAGPIE_REVIEW_PI_MODEL.slice(MAGPIE_PROVIDER.length + 1);
export const MAGPIE_REVIEW_EFFORT = reviewTarget.effort;

const MAGPIE_CONNECT_TIMEOUT_MS = 2_000;

/** The review has no other model route, so an unreachable magpie refuses the round before any launch. */
export function assertMagpieReachable(): Promise<void> {
  const { hostname } = new URL(MAGPIE_BASE_URL);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: MAGPIE_PORT });
    const refuse = () => { socket.destroy(); reject(new Error(`review_magpie_unreachable: ${MAGPIE_BASE_URL} does not answer; start magpie, then repeat the round`)); };
    socket.setTimeout(MAGPIE_CONNECT_TIMEOUT_MS, refuse);
    socket.once('error', refuse);
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
}
