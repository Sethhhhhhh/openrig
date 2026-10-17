import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ArgvExecFn } from "./tmux.js";

/**
 * tmux commands over one long-lived control-mode client (`tmux -C`) instead of a new tmux client per command.
 *
 * Each spawned client costs the daemon a fork of its whole process: some 28 ms of CPU a command at its size, against
 * 0.3 ms for a line written to a client already connected. The client is attached to a session of its own, which the
 * daemon's listings leave out. What it runs and what it gives back are the spawned client's: the same command line,
 * the same stdout, the same error text in `execStderr`, a chain stopped at its first failing command. Anything else
 * (a launch, which takes the spawning process's environment; `load-buffer`, see ROUTED; a command line that cannot be
 * written on one line; a global flag; a tmux before 3.2; no server yet) goes to the spawned client, as before.
 */

export const CONTROL_SESSION = "openrig-control";

/** Leaves the control session out of a listing (tmux 3.2 and later). */
const NOT_CONTROL_SESSION = `#{!=:#{session_name},${CONTROL_SESSION}}`;

// Commands that only read the server or write into a pane, whose outcome does not depend on the client that sends
// them as long as they name their target. A launch or an environment change stays spawned. So does `load-buffer`: it
// would have the server open the file itself, in its own loop (a FIFO with no writer stops the whole server) and in its
// own view of the filesystem, where a spawned client reads the file and hands the server its bytes.
const ROUTED = new Set([
  "capture-pane", "display-message", "has-session", "list-sessions", "list-windows", "list-panes", "list-clients",
  "show-environment", "paste-buffer", "delete-buffer", "send-keys",
]);

/** Whether a command acts on the same target from any client: a control client's own session would otherwise be the
 *  "current" one that a target-less command reads. */
function namesItsTarget(args: string[]): boolean {
  const [command] = args;
  if (args.includes("-t")) return true;
  if (command === "list-sessions" || command === "list-clients" || command === "delete-buffer") return true;
  if (command === "list-windows" || command === "list-panes") return args.includes("-a");
  if (command === "show-environment") return args.includes("-g");
  return false;
}

/** The argv's commands, split where it chains them with a bare `;` (as tmux's own command line does). */
function commandsOf(args: string[]): string[][] {
  const commands: string[][] = [[]];
  for (const arg of args) {
    if (arg === ";") commands.push([]);
    else commands[commands.length - 1]!.push(arg);
  }
  return commands;
}

/** A listing of every session, window or pane, with the control session left out, unless it filters already. */
export function withoutControlSession(argv: string[]): string[] {
  const [bin, command, ...rest] = argv;
  if (bin !== "tmux" || rest.includes("-f")) return argv;
  const everything = command === "list-sessions" || ((command === "list-windows" || command === "list-panes") && rest.includes("-a"));
  return everything ? [bin, command, "-f", NOT_CONTROL_SESSION, ...rest] : argv;
}

/** One argument on a control-mode command line: in single quotes, where tmux expands nothing; a ' closes them, is
 *  escaped, and opens them again. */
function quote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Whether tmux's version line names 3.2 or later: control-mode attach flags and listing filters. */
export function supportsControlMode(versionLine: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionLine);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 3 || (major === 3 && Number(match[2]) >= 2);
}

interface Pending {
  resolve: (reply: { ok: boolean; lines: string[] }) => void;
  reject: (error: Error) => void;
}

/** The replies of one control client, read off its stdout: each command's `%begin` … `%end` (or `%error`) block, in
 *  the order the commands were written. A block ends only on the line that repeats its own `%begin` header, so a pane
 *  line reading `%end …` never ends it. Only a block whose flags (the header's third field) say the client sent the
 *  command answers one: a hook (`after-list-panes` in a user's tmux.conf) prints its own blocks, flagged 0, between
 *  them. */
export class ControlReplies {
  private partial = "";
  private header: string | null = null;
  private lines: string[] = [];
  private readonly pending: Pending[] = [];
  /** The first block answers the attach itself, before any command was written. */
  private attached = false;
  /** Set once the client is gone: nothing will be answered any more. */
  private failure: Error | null = null;
  onAttached?: () => void;

  get closed(): boolean {
    return this.failure !== null;
  }

  expect(pending: Pending): void {
    if (this.failure) pending.reject(this.failure);
    else this.pending.push(pending);
  }

  push(chunk: string): void {
    this.partial += chunk;
    let newline: number;
    while ((newline = this.partial.indexOf("\n")) >= 0) {
      this.line(this.partial.slice(0, newline).replace(/\r$/, ""));
      this.partial = this.partial.slice(newline + 1);
    }
  }

  private line(line: string): void {
    if (this.header === null) {
      if (line.startsWith("%begin ")) {
        this.header = line.slice("%begin ".length);
        this.lines = [];
      }
      return;
    }
    if (line === `%end ${this.header}` || line === `%error ${this.header}`) {
      const ok = line.startsWith("%end ");
      const flags = Number(this.header.split(" ")[2]);
      this.header = null;
      if (!this.attached) {
        this.attached = true;
        this.onAttached?.();
        return;
      }
      if ((flags & 1) === 0) return;
      this.pending.shift()?.resolve({ ok, lines: this.lines });
      return;
    }
    this.lines.push(line);
  }

  /** Fails every command still waiting, and any expected later: the client is gone, so none will be answered. */
  failAll(error: Error): void {
    this.failure ??= error;
    for (const p of this.pending.splice(0)) p.reject(error);
  }
}

/** The error a spawned tmux would have thrown for this failure: tmux's text on stderr, the earlier commands' output on
 *  stdout. Its message is execFile's (the command, then stderr as is), with the output `execArgvCommand` appends to it. */
function commandFailed(argv: string[], stdout: string, stderr: string): Error {
  const message = `Command failed: ${argv.join(" ")}\n${stderr}`;
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return Object.assign(new Error(output && !message.includes(output) ? `${message}\n${output}` : message), {
    code: 1, stdout, stderr, execStderr: stderr,
  });
}

/** Spawns the control client; tests give their own. */
export type SpawnControlClient = () => ChildProcessWithoutNullStreams;

export interface TmuxControlOptions {
  spawnClient?: SpawnControlClient;
  /** A read with no reply within this is asked again of a spawned client; the control client goes on. Also the time
   *  the client has to attach. */
  replyTimeoutMs?: number;
  now?: () => number;
}

const RETRY_MS = [1_000, 5_000, 30_000];

const NOT_WRITTEN = new Error("tmux control client ended before the command was written");

interface ControlClient {
  child: ChildProcessWithoutNullStreams;
  replies: ControlReplies;
}

/**
 * The ArgvExecFn the daemon's TmuxAdapter runs with: routed commands go to the control client, every other one, or any
 * while the client cannot run, to `fallback` (the spawned client).
 */
export function tmuxControlExec(fallback: ArgvExecFn, options: TmuxControlOptions = {}): ArgvExecFn & { close: () => void } {
  const spawnClient = options.spawnClient ?? (() => spawn("tmux", ["-C", "attach-session", "-t", `=${CONTROL_SESSION}`, "-f", "no-output,ignore-size"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  }));
  const replyTimeoutMs = options.replyTimeoutMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  /** null until tmux's version is read; false for one before 3.2, which keeps every command spawned. */
  let supported: boolean | null = null;
  let client: ControlClient | null = null;
  let starting: Promise<ControlClient | null> | null = null;
  let failures = 0;
  let retryAt = 0;

  const drop = (child: ChildProcessWithoutNullStreams, reason: string): void => {
    if (client?.child !== child) return;
    client.replies.failAll(new Error(`tmux control client ended: ${reason}`));
    client = null;
    retryAt = now() + RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!;
    failures++;
    child.kill();
  };

  /** The control session, made when the server runs without it; false when there is no server to make it on. */
  const ensureSession = async (): Promise<boolean> => {
    try {
      await fallback(["tmux", "has-session", "-t", `=${CONTROL_SESSION}`]);
      return true;
    } catch (err) {
      const text = String((err as Error).message);
      if (!/can't find session|session not found/i.test(text)) return false;
    }
    try {
      // A shell would read the user's rc files; this waits forever on anything with a sleep.
      await fallback(["tmux", "new-session", "-d", "-s", CONTROL_SESSION, "-x", "80", "-y", "24", "sh -c 'while :; do sleep 86400; done'"]);
      return true;
    } catch (err) {
      return /duplicate session/.test(String((err as Error).message));
    }
  };

  const start = async (): Promise<ControlClient | null> => {
    if (supported === null) {
      try {
        supported = supportsControlMode(await fallback(["tmux", "-V"]));
      } catch {
        return null; // tmux could not even say its version: asked again later.
      }
    }
    if (!supported || !(await ensureSession())) {
      retryAt = now() + RETRY_MS[RETRY_MS.length - 1]!;
      return null;
    }
    const child = spawnClient();
    const replies = new ControlReplies();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => replies.push(chunk));
    child.stderr.resume();
    child.on("error", (err) => drop(child, err.message));
    child.on("exit", (code, signal) => drop(child, `exited (${signal ?? code})`));
    child.stdin.on("error", (err) => drop(child, err.message));
    // The daemon's exit is never held by its control client.
    child.unref();
    for (const stream of [child.stdin, child.stdout, child.stderr] as unknown[]) (stream as { unref?: () => void }).unref?.();
    const attached = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), replyTimeoutMs);
      replies.onAttached = () => { clearTimeout(timer); resolve(true); };
      child.once("exit", () => { clearTimeout(timer); resolve(false); });
    });
    if (!attached) {
      client = { child, replies };
      drop(child, "did not attach");
      return null;
    }
    failures = 0;
    client = { child, replies };
    return client;
  };

  const connected = async (): Promise<ControlClient | null> => {
    if (client) return client;
    if (supported === false || now() < retryAt) return null;
    starting ??= start().finally(() => { starting = null; });
    return starting;
  };

  /** One command's reply. A read with none in time fails alone, without ending the client its other commands share: it
   *  keeps its place in line, so its late reply is still taken for it (and dropped) and every later reply stays its own
   *  command's. A write waits for its reply, as a spawned client waits for tmux: timing it out would report a failure
   *  for input that may have landed. */
  const send = (target: ControlClient, args: string[], deadline: boolean): Promise<{ ok: boolean; lines: string[] }> =>
    new Promise((resolve, reject) => {
      // A chain's client may have ended after an earlier command's reply: nothing is written to it.
      if (target.replies.closed) {
        reject(NOT_WRITTEN);
        return;
      }
      const timer = deadline ? setTimeout(() => reject(new Error(`tmux control client: no reply within ${replyTimeoutMs} ms`)), replyTimeoutMs) : undefined;
      target.replies.expect({
        resolve: (reply) => { clearTimeout(timer); resolve(reply); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      target.child.stdin.write(`${args.map(quote).join(" ")}\n`);
    });

  const exec = async (argvIn: string[]): Promise<string> => {
    const [bin, ...argsIn] = argvIn;
    const routable = bin === "tmux" && argsIn.length > 0 && !argsIn[0]!.startsWith("-")
      && commandsOf(argsIn).every((c) => c.length > 0 && ROUTED.has(c[0]!) && namesItsTarget(c))
      && argsIn.every((a) => !/[\n\r\0]/.test(a));
    const target = routable ? await connected() : null;
    // Once tmux is known to filter (3.2 and later), the control session may exist: every listing leaves it out.
    const argv = supported ? withoutControlSession(argvIn) : argvIn;
    if (!target) return fallback(argv);
    const commands = commandsOf(argv.slice(1));
    const writes = commands.some((c) => c[0] === "send-keys" || c[0] === "paste-buffer");
    let stdout = "";
    for (const [index, command] of commands.entries()) {
      let reply: { ok: boolean; lines: string[] };
      try {
        reply = await send(target, command, !writes);
      } catch (err) {
        // A read, or a call of which nothing was written, is run again by a spawned client. A write fails when its
        // client ended after it was written: it may have landed, so its failure is reported, never repeated.
        if (writes && !(err === NOT_WRITTEN && index === 0)) throw err;
        return fallback(argv);
      }
      const text = reply.lines.length > 0 ? `${reply.lines.join("\n")}\n` : "";
      if (!reply.ok) throw commandFailed(argv, stdout, text);
      stdout += text;
    }
    return stdout;
  };

  return Object.assign(exec, {
    close: () => { if (client) { const { child } = client; client.replies.failAll(new Error("tmux control client closed")); client = null; child.kill(); } },
  });
}
