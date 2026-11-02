let _verbose = false;

export function setVerbose(enabled: boolean): void {
  _verbose = enabled;
}

export function isVerbose(): boolean {
  return _verbose;
}

export function verbose(msg: string): void {
  if (_verbose) process.stderr.write(`[verbose] ${msg}\n`);
}
