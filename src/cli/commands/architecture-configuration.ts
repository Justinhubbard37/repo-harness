import {
  DEFAULT_GLOBAL_ARCHITECTURE,
  readGlobalArchitectureConfiguration,
} from '../../effects/architecture/projection-config';
import type { ArchitectureSetupStep, GlobalConfigurationWrite } from '../../core/architecture/contracts';

/** `write` runs each change under the runtime transaction of the caller. */
export function ensureGlobalArchitectureProjection(env: NodeJS.ProcessEnv, write: GlobalConfigurationWrite): ArchitectureSetupStep {
  try {
    const current = readGlobalArchitectureConfiguration(env);
    if (!current.initialized) write((config) => ({ config: { ...config, architecture: DEFAULT_GLOBAL_ARCHITECTURE }, value: undefined }));
    const detail = !current.initialized ? `configured ${current.path}: archctx / manual` : `using ${current.path}`;
    return { step: 'global architecture projection', status: 'ok', detail };
  } catch (error) {
    return { step: 'global architecture projection', status: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
