import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export function codexCommand(): { executable: string; prefix: string[] } {
  if (process.platform === 'win32')
    return {
      executable: join(
        packageRoot,
        'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
      ),
      prefix: [],
    };
  const js = join(packageRoot, 'node_modules/@openai/codex/bin/codex.js');
  return { executable: process.execPath, prefix: [js] };
}
function toml(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(toml).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + '=' + toml(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  readonly version = '0.170.0';
  async start(options?: { token: string; endpoint: string }) {
    if (this.child) return;
    const { executable, prefix } = codexCommand();
    const config: Record<string, unknown> = {
      mcp_servers: options
        ? {
            menki: {
              command: process.execPath,
              args: [fileURLToPath(new URL('./mcp.js', import.meta.url))],
              env: { MENKI_TOOL_TOKEN: options.token, MENKI_BROKER: options.endpoint },
              startup_timeout_sec: 15,
              tool_timeout_sec: 300,
              tools: Object.fromEntries(
                [
                  'projects',
                  'tasks',
                  'create_task',
                  'start_task',
                  'stop_task',
                  'update_task',
                  'files',
                  'read_file',
                  'write_file',
                  'search_code',
                  'run_checks',
                  'remember',
                  'memories',
                  'document',
                  'documents',
                  'ask_user',
                  'request_action',
                ].map((name) => [name, { approval_mode: 'approve' }]),
              ),
            },
          }
        : {},
      'features.apps': false,
      'features.plugins': false,
      'features.hooks': false,
      'features.shell_tool': false,
      'features.apply_patch_freeform': false,
      'features.multi_agent': false,
      'features.multi_agent_v2': false,
      'features.in_app_browser': false,
      'features.computer_use': false,
      'features.browser_use': false,
      'features.browser_use_external': false,
      'features.code_mode.direct_only_tool_namespaces': ['mcp__menki'],
      approval_policy: 'never',
      check_for_update_on_startup: false,
      'shell_environment_policy.inherit': 'none',
    };
    const args = [
      ...prefix,
      'app-server',
      ...Object.entries(config).flatMap(([k, v]) => ['-c', k + '=' + toml(v)]),
    ];
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|TEMP|TMP|SYSTEMDRIVE|COMSPEC|HOMEDRIVE|HOMEPATH|PATHEXT|PROGRAMDATA|PROGRAMFILES.*)$/i.test(
          key,
        ),
      ),
    );
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        const call = this.pending.get(message.id);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message ?? 'Codex protocol error'));
        else call.resolve(message.result);
      } else if (message.id !== undefined) {
        // Native tool authority is unavailable. Questions use the broker, with a durable record.
        this.send({
          id: message.id,
          result: message.method?.includes('requestUserInput')
            ? { answers: {} }
            : { decision: 'decline' },
        });
        this.emit('nativeRequest', message.method);
      } else this.emit('notification', message);
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => this.fail(error));
    child.on('close', (code) => {
      this.child = null;
      this.fail(new Error('La connexion Codex s’est arrêtée' + (code ? ' (' + code + ')' : '')));
    });
    const result = await this.request('initialize', {
      clientInfo: { name: 'menki_local', title: 'Menki', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    this.emit('ready', result);
  }
  private send(message: unknown) {
    if (!this.child?.stdin.writable) throw new Error('Codex est déconnecté.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown = {}, timeout = 45000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex ne répond pas à ' + method));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private fail(error: Error) {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
    this.emit('disconnected', error);
  }
  close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 5000);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
}
