import * as crypto from 'crypto';

export function computeContentSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}
