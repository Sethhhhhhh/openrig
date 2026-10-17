import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ArgvExecFn } from "./tmux.js";

/**
 * tmux commands over one long-lived control-mode client (`tmux -C`) instead of a new tmux client per command.
 *
 * Each spawned client costs the daemon a fork of its whole process: some 28 ms of CPU a command at its size, against
 * 0.3 ms for a line written to a client already connected. The client is attached to a session of its own, marked with
 * the `@openrig-control` option whatever it is named later, which the daemon's listings leave out and which it kills
 * when it stops. What it runs and what it gives back are the spawned client's: the same commands, the same stdout, the
 * same error text in `execStderr`, a chain stopped at its first failing command. A chain's commands are sent one after
 * the other's reply, so another client's command may run between them, which it cannot in a spawned client's chain.
 * Anything else (a launch, which takes the spawning process's environment; `load-buffer`, see ROUTED; a command line
 * that cannot be written on one line; a global flag; a tmux before 3.2; no server yet) goes to the spawned client, as
 * before.
 */

export const CONTROL_SESSION = "openrig-control";

/** The session option that marks the control session, set as it is made: a rename keeps it. */
export const CONTROL_OPTION = "@openrig-control";

/** True in the control session (its windows and panes too): a format a listing's field or filter tests. Any tmux
 *  expands an unset user option to nothing, so it holds on a tmux this client never runs on. */
export const IS_CONTROL_SESSION = `#{==:#{${CONTROL_OPTION}},1}`;

/** Leaves the control session out of a listing (tmux 3.2 and later). */
const NOT_CONTROL_SESSION = `#{!=:#{${CONTROL_OPTION}},1}`;

/** What the control session's pane runs, exec'd as argv (no `default-shell -c`, so no shell of the user's and none of
 *  its rc files): a non-interactive sh that waits forever. */
const KEEP_ALIVE = ["sh", "-c", "while :; do sleep 86400; done"];

/** How long the daemon's stop waits for the control session to be killed. */
const CLOSE_MS = 2_000;

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

/** The argv's commands, as a spawned tmux reads its arguments (cmd-parse.c): an argument ending in `;` ends its
 *  command and keeps the rest (`abc;` is `abc`, then a new command); one ending in `\;` is kept with a literal `;`
 *  instead (`abc\;` is `abc;`). An empty command is skipped. Each argument is then sent quoted, as it reads. */
export function commandsOf(args: string[]): string[][] {
  const commands: string[][] = [];
  let command: string[] = [];
  for (const arg of args) {
    if (!arg.endsWith(";")) {
      command.push(arg);
      continue;
    }
    const rest = arg.slice(0, -1);
    if (rest.endsWith("\\")) {
      command.push(`${rest.slice(0, -1)};`);
      continue;
    }
    if (rest !== "") command.push(rest);
    if (command.length > 0) commands.push(command);
    command = [];
  }
  if (command.length > 0) commands.push(command);
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
  /** Called after each command's reply. */
  onReply?: () => void;

  get closed(): boolean {
    return this.failure !== null;
  }

  /** The commands written and not answered yet. */
  get waiting(): number {
    return this.pending.length;
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
      this.onReply?.();
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
  /** Once the command at the head of the line has had no reply for this long, the client is ended: the reads it owed
   *  are asked again of a spawned client, the writes it owed fail, and the next command starts a new client. Also the
   *  time a client has to attach. */
  replyTimeoutMs?: number;
  now?: () => number;
}

const RETRY_MS = [1_000, 5_000, 30_000];

const NOT_WRITTEN = new Error("tmux control client ended before the command was written");

interface ControlClient {
  child: ChildProcessWithoutNullStreams;
  replies: ControlReplies;
  /** Since when the command at the head of the line has waited: its write, or the reply before it. */
  headSince: number;
  /** Fires once that wait is past the reply timeout. */
  timer?: ReturnType<typeof setTimeout>;
}

export type TmuxControlExec = ArgvExecFn & { close: () => Promise<void> };

/**
 * The ArgvExecFn the daemon's TmuxAdapter runs with: routed commands go to the control client, every other one, or any
 * while the client cannot run, to `fallback` (the spawned client).
 */
export function tmuxControlExec(fallback: ArgvExecFn, options: TmuxControlOptions = {}): TmuxControlExec {
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

  const backOff = (): void => {
    retryAt = now() + RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!;
    failures++;
  };

  /** Ends the client and fails what it still owes. One that ended on its own is started again after a while; one
   *  dropped for a reply overdue, at the next command. */
  const drop = (child: ChildProcessWithoutNullStreams, reason: string, overdue = false): void => {
    if (client?.child !== child) return;
    clearTimeout(client.timer);
    client.replies.failAll(new Error(`tmux control client ended: ${reason}`));
    client = null;
    if (overdue) retryAt = 0;
    else backOff();
    child.kill();
  };

  /** Drops the client once the command at the head of its line has waited past the reply timeout: every later command
   *  waits behind it, a write with no deadline of its own included. */
  const watch = (c: ControlClient): void => {
    clearTimeout(c.timer);
    if (c.replies.waiting === 0) return;
    c.timer = setTimeout(() => {
      if (now() - c.headSince >= replyTimeoutMs) drop(c.child, `no reply within ${replyTimeoutMs} ms`, true);
      else watch(c);
    }, Math.max(0, c.headSince + replyTimeoutMs - now()));
    c.timer.unref?.();
  };

  /** The control session's id on the server it was last made or marked on, which the daemon's stop kills. */
  let sessionId: string | null = null;
  let closed = false;

  /** The control session, made when the server runs without it, and marked (one an older daemon made is marked too):
   *  its id, or null when there is no server to make it on. It never moves a client that is in it elsewhere when it
   *  is killed (`detach-on-destroy on`). */
  const ensureSession = async (): Promise<string | null> => {
    const target = `=${CONTROL_SESSION}:`;
    const mark = ["set-option", "-t", target, CONTROL_OPTION, "1", ";", "set-option", "-t", target, "detach-on-destroy", "on",
      ";", "display-message", "-p", "-t", target, "#{session_id}"];
    try {
      return (await fallback(["tmux", ...mark])).trim();
    } catch (err) {
      if (!/can't find session|no such session|session not found/i.test(String((err as Error).message))) return null;
    }
    try {
      return (await fallback(["tmux", "new-session", "-d", "-s", CONTROL_SESSION, "-x", "80", "-y", "24", "--", ...KEEP_ALIVE, ";", ...mark])).trim();
    } catch (err) {
      if (!/duplicate session/.test(String((err as Error).message))) return null;
    }
    try {
      return (await fallback(["tmux", ...mark])).trim();
    } catch {
      return null;
    }
  };

  const start = async (): Promise<ControlClient | null> => {
    if (supported === null) {
      try {
        supported = supportsControlMode(await fallback(["tmux", "-V"]));
      } catch {
        backOff(); // tmux could not even say its version: asked again later, not at every command.
        return null;
      }
    }
    if (!supported) return null;
    const id = await ensureSession();
    if (id === null) {
      retryAt = now() + RETRY_MS[RETRY_MS.length - 1]!;
      return null;
    }
    sessionId = id;
    if (closed) return null;
    const child = spawnClient();
    const replies = new ControlReplies();
    const started: ControlClient = { child, replies, headSince: 0 };
    replies.onReply = () => {
      started.headSince = now();
      watch(started);
    };
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
    client = started;
    if (!attached || closed) {
      drop(child, closed ? "closed" : "did not attach");
      return null;
    }
    failures = 0;
    return client;
  };

  const connected = async (): Promise<ControlClient | null> => {
    if (closed) return null;
    if (client) return client;
    if (supported === false || now() < retryAt) return null;
    starting ??= start().finally(() => { starting = null; });
    return starting;
  };

  /** One command's reply, or the client's end: the whole line is failed when its head waits too long (`watch`), so no
   *  command waits behind a client that stopped answering, and every reply stays its own command's. */
  const send = (target: ControlClient, args: string[]): Promise<{ ok: boolean; lines: string[] }> =>
    new Promise((resolve, reject) => {
      // A chain's client may have ended after an earlier command's reply: nothing is written to it.
      if (target.replies.closed) {
        reject(NOT_WRITTEN);
        return;
      }
      if (target.replies.waiting === 0) target.headSince = now();
      target.replies.expect({ resolve, reject });
      target.child.stdin.write(`${args.map(quote).join(" ")}\n`);
      watch(target);
    });

  /** The error of a write whose client ended before its reply, with what a spawned client finds of its target now: a
   *  server or session gone reads as a spawned client's failure would (`no server running`, `can't find session`), so
   *  the adapter classifies it the same way. A client dropped for no reply is not asked about: the server is not
   *  answering, and a spawned client would wait on it as long. */
  const failedWrite = async (command: string[], err: Error): Promise<Error> => {
    const t = command.indexOf("-t");
    if (err.message.includes("no reply within") || t < 0 || t + 1 >= command.length) return err;
    try {
      await fallback(["tmux", "display-message", "-p", "-t", command[t + 1]!, ""]);
      return err;
    } catch (probe) {
      const stderr = (probe as { execStderr?: unknown }).execStderr;
      return Object.assign(new Error(`${err.message}; then ${(probe as Error).message}`),
        typeof stderr === "string" ? { execStderr: stderr } : {});
    }
  };

  const exec = async (argvIn: string[]): Promise<string> => {
    const [bin, ...argsIn] = argvIn;
    const commandsIn = commandsOf(argsIn);
    const routable = bin === "tmux" && argsIn.length > 0 && !argsIn[0]!.startsWith("-") && commandsIn.length > 0
      && commandsIn.every((c) => ROUTED.has(c[0]!) && namesItsTarget(c))
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
        reply = await send(target, command);
      } catch (err) {
        // A read, or a call of which nothing was written, is run again by a spawned client. A write fails when its
        // client ended (or was dropped, its line overdue) after it was written: it may have landed, so its failure is
        // reported, never repeated.
        if (writes && !(err === NOT_WRITTEN && index === 0)) throw await failedWrite(command, err as Error);
        return fallback(argv);
      }
      const text = reply.lines.length > 0 ? `${reply.lines.join("\n")}\n` : "";
      if (!reply.ok) throw commandFailed(argv, stdout, text);
      stdout += text;
    }
    return stdout;
  };

  /** Ends the client, one being started included, and kills its session: the daemon is stopping. The kill names the
   *  session by id and checks its mark first, so a session that took the id on a newer server is left alone. */
  const close = async (): Promise<void> => {
    closed = true;
    await starting;
    if (client) drop(client.child, "closed");
    if (sessionId === null) return;
    const kill = fallback(["tmux", "if-shell", "-F", "-t", sessionId, IS_CONTROL_SESSION, `kill-session -t '${sessionId}'`]).catch(() => "");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([kill, new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_MS); })]);
    clearTimeout(timer);
  };

  return Object.assign(exec, { close });
}
