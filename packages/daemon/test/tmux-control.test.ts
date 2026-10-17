import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { commandsOf, ControlReplies, supportsControlMode, tmuxControlExec, withoutControlSession } from "../src/adapters/tmux-control.js";

function replies(): { replies: ControlReplies; answers: Array<{ ok: boolean; lines: string[] }>; attached: () => boolean } {
  const r = new ControlReplies();
  const answers: Array<{ ok: boolean; lines: string[] }> = [];
  let attached = false;
  r.onAttached = () => { attached = true; };
  for (let i = 0; i < 3; i++) r.expect({ resolve: (a) => answers.push(a), reject: () => {} });
  return { replies: r, answers, attached: () => attached };
}

describe("ControlReplies", () => {
  it("takes the attach's own block first, then answers each command in order, wherever the chunks split", () => {
    const { replies: r, answers, attached } = replies();
    const stream = "%begin 1 10 0\n%end 1 10 0\n%sessions-changed\n%begin 1 11 1\nfirst\n\nthird\n%end 1 11 1\n%begin 1 12 1\ncan't find session: x\n%error 1 12 1\n";
    for (const ch of stream) r.push(ch);
    expect(attached()).toBe(true);
    expect(answers).toEqual([{ ok: true, lines: ["first", "", "third"] }, { ok: false, lines: ["can't find session: x"] }]);
  });

  it("ends a block only on its own header: a pane line reading %end or %error is output", () => {
    const { replies: r, answers } = replies();
    r.push("%begin 1 1 0\n%end 1 1 0\n");
    r.push("%begin 5 7 1\n%end 5 6 1\n%error 9 9 9\n%begin 2 2 2\n%end 5 7 1\n");
    expect(answers).toEqual([{ ok: true, lines: ["%end 5 6 1", "%error 9 9 9", "%begin 2 2 2"] }]);
  });

  it("answers commands only with the blocks of the client's own commands: a hook's blocks (flags 0) are not replies", () => {
    const { replies: r, answers } = replies();
    r.push("%begin 1 10 0\n%end 1 10 0\n%begin 1 11 0\n%end 1 11 0\n");
    r.push("%begin 1 12 1\n%0\n%end 1 12 1\n%begin 1 13 0\nhook-output\nhook-output\n%end 1 13 0\n");
    r.push("%begin 1 14 1\nb1\n%end 1 14 1\n%begin 1 15 0\ncan't find pane\n%error 1 15 0\n%begin 1 16 1\nb2\n%end 1 16 1\n");
    expect(answers).toEqual([{ ok: true, lines: ["%0"] }, { ok: true, lines: ["b1"] }, { ok: true, lines: ["b2"] }]);
  });

  it("fails what is still waiting when the client is gone", () => {
    const r = new ControlReplies();
    const errors: string[] = [];
    r.expect({ resolve: () => {}, reject: (e) => errors.push(e.message) });
    r.failAll(new Error("gone"));
    expect(errors).toEqual(["gone"]);
    r.expect({ resolve: () => {}, reject: (e) => errors.push(`later: ${e.message}`) });
    expect(errors).toEqual(["gone", "later: gone"]);
    expect(r.closed).toBe(true);
  });
});

/** A control client that records the command lines written to it and answers only when told to. It attaches at once
 *  unless told to wait. */
function fakeClient(options: { attach?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), unref: () => {},
  });
  const written: string[] = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => written.push(...chunk.split("\n").filter(Boolean)));
  const attach = () => child.stdout.write("%begin 1 1 0\n%end 1 1 0\n");
  if (options.attach !== false) setImmediate(attach);
  let n = 1;
  const answer = (...lines: string[]) => { n++; child.stdout.write(`%begin 1 ${n} 1\n${lines.map((l) => `${l}\n`).join("")}%end 1 ${n} 1\n`); };
  const exit = () => child.emit("exit", null, "SIGTERM");
  return { child: child as unknown as ChildProcessWithoutNullStreams, kill: child.kill, written, answer, attach, exit };
}

/** The spawned tmux the control exec falls back to: its own calls (the version, the control session's mark, its
 *  kill) are answered here; every other argv is recorded and given to `answer`. */
function fakeSpawned(answer: (argv: string[]) => string | Promise<string> = () => "") {
  const spawned: string[][] = [];
  const own: string[][] = [];
  const fallback = async (argv: string[]): Promise<string> => {
    if (argv[1] === "-V") return "tmux 3.6\n";
    if (argv[1] === "set-option" || argv[1] === "if-shell") {
      own.push(argv);
      return "$7\n";
    }
    spawned.push(argv);
    return answer(argv);
  };
  return { spawned, own, fallback };
}

describe("tmuxControlExec", () => {
  it("drops a client once the reply at the head of its line is overdue, and starts a new one for the next command", async () => {
    const clients = [fakeClient(), fakeClient()];
    let started = 0;
    const { spawned, fallback } = fakeSpawned(() => "spawned read\n");
    const exec = tmuxControlExec(fallback, { spawnClient: () => clients[started++]!.child, replyTimeoutMs: 50 });

    const stuckRead = exec(["tmux", "capture-pane", "-p", "-J", "-t", "=seat@rig:", "-S", "-", "-E", "-"]);
    await vi.waitFor(() => expect(clients[0]!.written).toHaveLength(1));
    const writeError = exec(["tmux", "send-keys", "-t", "=seat@rig:", "Enter"]).then(() => null, (err: Error) => err.message);
    await vi.waitFor(() => expect(clients[0]!.written).toHaveLength(2), { interval: 5 });

    // No reply comes: the client is ended, the read asked of a spawned client, and the write, which was written to the
    // ended client and may have landed, reported failed rather than sent again.
    expect(await stuckRead).toBe("spawned read\n");
    expect(await writeError).toBe("tmux control client ended: no reply within 50 ms");
    expect(clients[0]!.kill).toHaveBeenCalled();
    expect(spawned.map((argv) => argv[1])).toEqual(["capture-pane"]);

    const read = exec(["tmux", "display-message", "-p", "-t", "=seat@rig:", "x"]);
    await vi.waitFor(() => expect(clients[1]!.written).toHaveLength(1));
    clients[1]!.answer("x");
    expect(await read).toBe("x\n");
    expect(started).toBe(2);
    await exec.close();
  });

  it("keeps a client whose line moves: each reply restarts the wait of the command behind it", async () => {
    const client = fakeClient();
    const { spawned, fallback } = fakeSpawned();
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 200 });

    const reads = [1, 2, 3].map((n) => exec(["tmux", "display-message", "-p", "-t", "=seat@rig:", `r${n}`]));
    await vi.waitFor(() => expect(client.written).toHaveLength(3), { interval: 5 });
    // 360 ms in all, each reply within 120 ms of the one before.
    for (const n of [1, 2, 3]) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      client.answer(`r${n}`);
    }
    expect(await Promise.all(reads)).toEqual(["r1\n", "r2\n", "r3\n"]);
    expect(client.kill).not.toHaveBeenCalled();
    expect(spawned).toEqual([]);
    await exec.close();
  });

  it("fails a chain's write whose client ended after an earlier command, without writing the rest to it", async () => {
    const client = fakeClient();
    const { spawned, fallback } = fakeSpawned();
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 50 });

    const chain = exec(["tmux", "paste-buffer", "-b", "b1", "-t", "=seat@rig:", ";", "delete-buffer", "-b", "b1"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    // The client ends as soon as its reply to the first command is read, before the chain goes on.
    client.child.stdout.once("data", client.exit);
    client.answer();
    await expect(chain).rejects.toThrow("before the command was written");
    expect(client.written).toHaveLength(1);
    expect(spawned).toEqual([]);
    await exec.close();
  });

  it("spawns load-buffer, alone or in a chain: the server would open the file itself", async () => {
    const client = fakeClient();
    const { spawned, fallback } = fakeSpawned();
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 50 });

    const read = exec(["tmux", "display-message", "-p", "-t", "=seat@rig:", "x"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    client.answer("x");
    await read;
    await exec(["tmux", "load-buffer", "-b", "b1", "/tmp/fifo"]);
    await exec(["tmux", "load-buffer", "-b", "b1", "/tmp/fifo", ";", "paste-buffer", "-b", "b1", "-t", "=seat@rig:"]);
    expect(spawned.map((argv) => argv[1])).toEqual(["load-buffer", "load-buffer"]);
    expect(client.written).toHaveLength(1);
    await exec.close();
  });

  it("marks its session as it makes it, and kills it by id, its mark checked, when closed", async () => {
    const client = fakeClient();
    const { own, fallback } = fakeSpawned();
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 50 });
    const read = exec(["tmux", "has-session", "-t", "=seat@rig"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    client.answer();
    await read;
    expect(own[0]).toEqual(["tmux", "set-option", "-t", "=openrig-control:", "@openrig-control", "1", ";",
      "set-option", "-t", "=openrig-control:", "detach-on-destroy", "on", ";", "display-message", "-p", "-t", "=openrig-control:", "#{session_id}"]);
    await exec.close();
    expect(client.kill).toHaveBeenCalled();
    expect(own[1]).toEqual(["tmux", "if-shell", "-F", "-t", "$7", "#{==:#{@openrig-control},1}", "kill-session -t '$7'"]);
  });

  it("closed while its client attaches, ends that client and kills its session, then spawns what it is given", async () => {
    const client = fakeClient({ attach: false });
    const { spawned, own, fallback } = fakeSpawned(() => "spawned\n");
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 1000 });
    const read = exec(["tmux", "has-session", "-t", "=seat@rig"]);
    await vi.waitFor(() => expect(own).toHaveLength(1));
    const closing = exec.close();
    client.attach();
    await closing;
    expect(client.kill).toHaveBeenCalled();
    expect(own.map((argv) => argv[1])).toEqual(["set-option", "if-shell"]);
    expect(await read).toBe("spawned\n");
    expect(await exec(["tmux", "has-session", "-t", "=seat@rig"])).toBe("spawned\n");
    expect(spawned).toHaveLength(2);
    expect(client.written).toEqual([]);
  });
});

describe("control-mode rules", () => {
  it("splits and unescapes the argv's commands at ; as a spawned tmux does", () => {
    expect(commandsOf(["display-message", "-p", "abc;", "list-sessions"])).toEqual([["display-message", "-p", "abc"], ["list-sessions"]]);
    expect(commandsOf(["display-message", "-p", "abc\\;"])).toEqual([["display-message", "-p", "abc;"]]);
    expect(commandsOf(["display-message", "-p", "abc\\\\;"])).toEqual([["display-message", "-p", "abc\\;"]]);
    expect(commandsOf(["display-message", "-p", "\\;", ";", "has-session"])).toEqual([["display-message", "-p", ";"], ["has-session"]]);
    expect(commandsOf([";", "has-session", ";", ";", "list-sessions", ";"])).toEqual([["has-session"], ["list-sessions"]]);
    expect(commandsOf(["send-keys", "-l", "a;b", "it's"])).toEqual([["send-keys", "-l", "a;b", "it's"]]);
  });

  it("writes each command of the argv on its own line, its arguments as tmux read them", async () => {
    const client = fakeClient();
    const { spawned, fallback } = fakeSpawned();
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 1000 });

    const run = exec(["tmux", "display-message", "-p", "-t", "=s:", "abc;", "display-message", "-p", "-t", "=s:", "x\\;"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    client.answer("abc");
    await vi.waitFor(() => expect(client.written).toHaveLength(2));
    client.answer("x;");
    expect(await run).toBe("abc\nx;\n");
    expect(client.written).toEqual(["'display-message' '-p' '-t' '=s:' 'abc'", "'display-message' '-p' '-t' '=s:' 'x;'"]);
    expect(spawned).toEqual([]);
    await exec.close();
  });

  it("needs tmux 3.2 or later", () => {
    expect(supportsControlMode("tmux 3.3a\n")).toBe(true);
    expect(supportsControlMode("tmux 3.2")).toBe(true);
    expect(supportsControlMode("tmux next-3.6")).toBe(true);
    expect(supportsControlMode("tmux 3.1c")).toBe(false);
    expect(supportsControlMode("tmux 2.9")).toBe(false);
    expect(supportsControlMode("psmux")).toBe(false);
  });

  it("filters only the listings of everything, on the control session's mark, and never twice", () => {
    expect(withoutControlSession(["tmux", "list-sessions", "-F", "#{session_name}"]))
      .toEqual(["tmux", "list-sessions", "-f", "#{!=:#{@openrig-control},1}", "-F", "#{session_name}"]);
    expect(withoutControlSession(["tmux", "list-panes", "-a", "-F", "x"])[2]).toBe("-f");
    expect(withoutControlSession(["tmux", "list-windows", "-a", "-F", "x"])[2]).toBe("-f");
    expect(withoutControlSession(["tmux", "list-panes", "-t", "=s:", "-F", "x"])).toEqual(["tmux", "list-panes", "-t", "=s:", "-F", "x"]);
    expect(withoutControlSession(["tmux", "list-sessions", "-f", "#{x}"])).toEqual(["tmux", "list-sessions", "-f", "#{x}"]);
    expect(withoutControlSession(["tmux", "capture-pane", "-p", "-t", "=s:"])).toEqual(["tmux", "capture-pane", "-p", "-t", "=s:"]);
  });
});
