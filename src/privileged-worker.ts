// Privileged worker entry point. Runs as root via sudo: compiled to
// dist/privileged-worker.js and staged together with dist/privileged-worker/
// (its helper modules), so it and its helpers import only Node built-ins.
import * as fs from 'fs';
import * as net from 'net';
import { runSession } from './privileged-worker/session';

export type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WriteOp,
} from './privileged-worker/types';
export { parseMode } from './privileged-worker/fs-helpers';
export { handleWriteMv } from './privileged-worker/write-mv';
export { handleWriteInPlace } from './privileged-worker/write-in-place';
export { handleWriteSymlink } from './privileged-worker/write-symlink';
export { handleDelete } from './privileged-worker/delete';
export { dispatch } from './privileged-worker/dispatch';

interface Channel {
  inputStream: NodeJS.ReadableStream;
  outputStream: NodeJS.WritableStream;
}

function connectSocket(socketPathArg: string): Channel {
  const socketPath = socketPathArg.slice('--socket-path='.length);
  const ipcSocket = net.createConnection(socketPath);
  ipcSocket.setNoDelay(true);
  // Nonce is passed via AVANTI_WORKER_NONCE env var (not cmdline) so that
  // it does not appear in /proc/<pid>/cmdline, which is world-readable on Linux.
  // The parent uses `sudo --preserve-env=AVANTI_WORKER_NONCE` to forward it.
  const nonce = process.env.AVANTI_WORKER_NONCE;
  // Send the nonce back as the very first line so the parent can verify this
  // is the worker it spawned (not a rogue process that connected to the socket
  // before us). Must be sent before any request is processed.
  if (!nonce) {
    process.stderr.write(
      'avanti-worker: AVANTI_WORKER_NONCE is not set — sudo env_reset may have stripped it.\n' +
        'Add `Defaults env_keep += "AVANTI_WORKER_NONCE"` to /etc/sudoers or allow SETENV for the invoking user.\n',
    );
    process.exit(1);
  }
  ipcSocket.write(nonce + '\n');
  return { inputStream: ipcSocket, outputStream: ipcSocket };
}

function openReqFile(reqFileArg: string): Channel {
  const reqFilePath = reqFileArg.slice('--req-file='.length);
  const reqStream = fs.createReadStream(reqFilePath);
  // Unlink the req file as soon as it is opened so the base64 content does
  // not sit on disk for the full duration of the worker's run. The data
  // remains accessible via the open file descriptor; the parent's finally
  // block also tries to unlink (harmlessly no-ops if already gone).
  reqStream.once('open', () => {
    try {
      fs.unlinkSync(reqFilePath);
    } catch {
      // best-effort
    }
  });
  return { inputStream: reqStream, outputStream: process.stdout };
}

function useStdin(): Channel {
  // stdin fallback: used by runPrivilegedWorker (named-user path, spawnSync
  // with stdio:['pipe',...]) and for backward-compatibility. The nonce IS
  // verified in this mode: the parent prefixes the payload with the nonce line
  // and passes AVANTI_WORKER_NONCE via env. Security requirement: stdin MUST
  // be a private pipe so only the parent process can write to it.
  if (process.stdin.isTTY) {
    process.stderr.write(
      'avanti-worker: stdin is a TTY; refusing to accept ops on an unauthenticated channel\n',
    );
    process.exit(1);
  }
  return { inputStream: process.stdin, outputStream: process.stdout };
}

// Determine the input source from command-line flags:
//   --socket-path=P : connect to the Unix domain socket at P for bidirectional
//                     JSON IPC (SudoWorkerSession passes this so stdin can be
//                     /dev/tty, allowing macOS sudo to find cached credentials
//                     via ttyname(STDIN_FILENO) instead of returning NULL).
//                     Replaced the old --data-fd=N approach which required
//                     `sudo -C 4` to keep fd 3 open — but `sudo -C` needs
//                     `closefrom_override` in sudoers (disabled by default).
//   --req-file=P    : read a single request from file P then exit
//   (default)       : read from stdin (tests, manual invocation, backward compat)
function openChannel(): Channel {
  const socketPathArg = process.argv.find((a) =>
    a.startsWith('--socket-path='),
  );
  if (socketPathArg) return connectSocket(socketPathArg);
  const reqFileArg = process.argv.find((a) => a.startsWith('--req-file='));
  if (reqFileArg) return openReqFile(reqFileArg);
  return useStdin();
}

// Entry point: only run when this file is the main module, not when imported.
if (require.main === module) {
  const { inputStream, outputStream } = openChannel();
  runSession(inputStream, outputStream);
}
