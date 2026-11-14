import * as crypto from 'crypto';

export function computeContentSha256(content: string | Buffer): string {
  const hash = crypto.createHash('sha256');
  if (typeof content === 'string') {
    hash.update(content, 'utf8');
  } else {
    hash.update(content);
  }
  return hash.digest('hex');
}
