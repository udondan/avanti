/** Fetching config content from local or remote locations. */
import * as fs from 'fs';
import { Via } from '../types';
import { fetchHttp } from '../sources/http';
import { fetchGitHub } from '../sources/github';
import { fetchGitLab } from '../sources/gitlab';
import { fetchGit, isGitRemoteUrl, parseGitRemoteSpec } from '../sources/git';
import { parseGitHubSpec, parseGitLabSpec } from './discovery';

function singleFileContent(
  result: { files: Map<string, Buffer> },
  spec: string,
): string {
  if (result.files.size !== 1) {
    throw new Error(
      `Remote config must be a single file, got ${result.files.size} files from "${spec}"`,
    );
  }
  return (result.files.values().next().value as Buffer).toString('utf8');
}

export async function fetchConfigContent(
  spec: string,
  via?: Via | Via[],
): Promise<string> {
  if (spec.startsWith('http://') || spec.startsWith('https://')) {
    return (await fetchHttp(spec)).toString('utf8');
  }

  if (spec.startsWith('github:')) {
    const { repo, file, ref } = parseGitHubSpec(spec);
    return singleFileContent(
      await fetchGitHub(repo, file, ref, undefined, via),
      spec,
    );
  }

  if (spec.startsWith('gitlab:')) {
    const { project, file, ref } = parseGitLabSpec(spec);
    return singleFileContent(
      await fetchGitLab(project, file, ref, undefined, via),
      spec,
    );
  }

  if (isGitRemoteUrl(spec)) {
    const { repo, file, ref } = parseGitRemoteSpec(spec);
    return singleFileContent(fetchGit(repo, file, ref), spec);
  }

  // Local file
  if (!fs.existsSync(spec)) {
    throw new Error(`Config file not found: ${spec}`);
  }
  return fs.readFileSync(spec, 'utf8');
}
