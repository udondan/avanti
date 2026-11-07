import { AvantiConfig, Via } from './types';
import { fetchConfigContent } from './config/load';
import { parseConfigContent } from './config/parse';

export {
  deriveConfigBase,
  isRemoteConfigSpec,
  normalizeConfigKey,
  parseGitHubSpec,
  parseGitLabSpec,
  resolveConfigPath,
  resolveRelativeSrc,
} from './config/discovery';
export { parseConfigContent } from './config/parse';
export { SELF_KEY } from './config/symlink';
export { parseVia } from './config/validate';

export async function loadConfig(
  configPath: string,
  via?: Via | Via[],
): Promise<AvantiConfig> {
  try {
    const content = await fetchConfigContent(configPath, via);
    return parseConfigContent(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse config file: ${msg}`, { cause: err });
  }
}
