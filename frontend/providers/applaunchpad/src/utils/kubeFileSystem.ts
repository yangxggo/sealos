import { PassThrough, Readable, Writable } from 'stream';
import * as k8s from '@kubernetes/client-node';

export type TFile = {
  name: string;
  path: string;
  dir: string;
  kind: string;
  attr: string;
  hardLinks: number;
  owner: string;
  group: string;
  size: number;
  updateTime: Date;
  linkTo?: string;
  processed?: boolean;
};

export class KubeFileSystem {
  private readonly k8sExec: k8s.Exec;

  constructor(k8sExec: k8s.Exec) {
    this.k8sExec = k8sExec;
  }

  execCommand(
    namespace: string,
    podName: string,
    containerName: string,
    command: string[],
    stdin: Readable | null = null,
    stdout: Writable | null = null
  ) {
    return new Promise<string>(async (resolve, reject) => {
      const stderr = new PassThrough();

      let chunks = Buffer.alloc(0);
      if (!stdout) {
        stdout = new PassThrough();
        stdout.on('data', (chunk) => {
          chunks = Buffer.concat([chunks, chunk]);
        });
      }

      const free = () => {
        stderr.removeAllListeners();
        stdout?.removeAllListeners();
        stdin?.removeAllListeners();
      };

      stdout.on('end', () => {
        free();
        resolve(chunks.toString());
      });
      stdout.on('error', (error) => {
        free();
        reject(error);
      });
      stderr.on('data', (error) => {
        free();
        reject(error.toString());
      });

      const WebSocket = await this.k8sExec.exec(
        namespace,
        podName,
        containerName,
        command,
        stdout,
        stderr,
        stdin,
        false
      );

      WebSocket.on('close', () => {
        resolve('success upload, close web socket');
      });

      if (stdin) {
        stdin.on('end', () => {
          free();
        });
      }
    });
  }

  async ls({
    namespace,
    podName,
    containerName,
    path,
    showHidden = false
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    path: string;
    showHidden: boolean;
  }) {
    let output: string;
    let isCompatibleMode = false;
    try {
      output = await this.execCommand(namespace, podName, containerName, [
        'ls',
        showHidden ? '-laQ' : '-lQ',
        '--color=never',
        '--full-time',
        path
      ]);
    } catch (error) {
      if (typeof error === 'string' && error.includes('ls: unrecognized option: full-time')) {
        isCompatibleMode = true;
        output = await this.execCommand(namespace, podName, containerName, [
          'ls',
          showHidden ? '-laQ' : '-lQ',
          '--color=never',
          '-e',
          path
        ]);
      } else {
        throw error;
      }
    }
    const lines: string[] = output.split('\n').filter((v) => v.length > 3);

    const directories: TFile[] = [];
    const files: TFile[] = [];
    const symlinks: TFile[] = [];

    lines.forEach((line) => {
      const parts = line.split('"');
      const name = parts[1];

      if (!name || name === '.' || name === '..') return;

      const attrs = parts[0].split(' ').filter((v) => !!v);
      const file: TFile = {
        name: name,
        path: (name.startsWith('/') ? '' : path + '/') + name,
        dir: path,
        kind: line[0],
        attr: attrs[0],
        hardLinks: parseInt(attrs[1]),
        owner: attrs[2],
        group: attrs[3],
        size: parseInt(attrs[4]),
        updateTime: new Date(attrs.slice(5, 7).join(' '))
      };

      if (isCompatibleMode) {
        file.updateTime = new Date(attrs.slice(5, 10).join(' '));
      }

      if (file.kind === 'c') {
        if (isCompatibleMode) {
          file.updateTime = new Date(attrs.slice(7, 11).join(' '));
        } else {
          file.updateTime = new Date(attrs.slice(6, 8).join(' '));
        }
        file.size = parseInt(attrs[5]);
      }
      if (file.kind === 'l') {
        file.linkTo = parts[3];
        symlinks.push(file);
      }
      if (file.kind === 'd') {
        directories.push(file);
      } else {
        if (file.kind !== 't' && file.kind !== '') {
          files.push(file);
        }
      }
    });

    if (symlinks.length > 0) {
      const command = ['ls', '-ldQ', '--color=never'];

      try {
        symlinks.forEach((symlink) => {
          let linkTo = symlink.linkTo!;
          if (linkTo[0] !== '/') {
            linkTo = (symlink.dir === '/' ? '' : symlink.dir) + '/' + linkTo;
          }
          symlink.linkTo = linkTo;
          command.push(linkTo);
        });
      } catch (error) {
      } finally {
        const output = await this.execCommand(namespace, podName, containerName, command);
        const lines = output.split('\n').filter((v) => !!v);

        try {
          for (const line of lines) {
            if (line && line.includes('command terminated with non-zero exit code')) {
              const parts = line.split('"');
              try {
                symlinks.map((symlink) => {
                  if (symlink.linkTo === parts[1] && !symlink.processed) {
                    symlink.processed = true;
                    symlink.kind = line[0];
                    if (symlink.kind === 'd') {
                      directories.push(symlink);
                    }
                  }
                });
              } catch (error) {}
            }
          }
        } catch (error) {}
      }
    }

    directories.sort((a, b) => (a.name > b.name ? 1 : -1));

    return {
      directories: directories,
      files: files
    };
  }

  async mv({
    namespace,
    podName,
    containerName,
    from,
    to
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    from: string;
    to: string;
  }) {
    return await this.execCommand(namespace, podName, containerName, ['mv', from, to]);
  }

  async rm({
    namespace,
    podName,
    containerName,
    path
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    path: string;
  }) {
    return await this.execCommand(namespace, podName, containerName, ['rm', '-rf', path]);
  }

  async download({
    namespace,
    podName,
    containerName,
    path,
    stdout
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    path: string;
    stdout: Writable;
  }) {
    return await this.execCommand(
      namespace,
      podName,
      containerName,
      ['dd', `if=${path}`, 'status=none'],
      null,
      stdout
    );
  }

  async mkdir({
    namespace,
    podName,
    containerName,
    path
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    path: string;
  }) {
    return await this.execCommand(namespace, podName, containerName, ['mkdir', path]);
  }

  async touch({
    namespace,
    podName,
    containerName,
    path
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    path: string;
  }) {
    return await this.execCommand(namespace, podName, containerName, ['touch', path]);
  }

  async upload({
    namespace,
    podName,
    containerName,
    path,
    file
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    path: string;
    file: PassThrough;
  }): Promise<string> {
    const result = await this.execCommand(
      namespace,
      podName,
      containerName,
      ['sh', '-c', `dd of=${path} status=none bs=32767`],
      file
    );
    return result;
  }

  async md5sum({
    namespace,
    podName,
    containerName,
    path
  }: {
    namespace: string;
    podName: string;
    containerName: string;
    path: string;
  }) {
    return await this.execCommand(namespace, podName, containerName, ['md5sum', path]);
  }
}
