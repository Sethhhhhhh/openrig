import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { commandsOf, ControlReplies, markOwnRows, supportsControlMode, tmuxControlExec, withoutOwnRows } from "../src/adapters/tmux-control.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";

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

/** The spawned tmux the control exec falls back to: its own call (the server's version, read before a client starts)
 *  is answered here; every other argv is recorded and given to `answer`. */
function fakeSpawned(answer: (argv: string[]) => string | Promise<string> = () => "") {
  const spawned: string[][] = [];
  const own: string[][] = [];
  const fallback = async (argv: string[]): Promise<string> => {
    if (argv[1] === "list-sessions" && argv[3] === "#{version}") {
      own.push(argv);
      return "3.6\n3.6\n";
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

  it("fails a write in flight when its client ends, never sends it again, and says what a spawned client finds", async () => {
    const client = fakeClient();
    const { spawned, fallback } = fakeSpawned();
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 1000 });

    // The control session is killed while the write waits for its reply: the seat is still there.
    const first = exec(["tmux", "send-keys", "-t", "=seat@rig:", "-l", "hello"]).then(() => null, (err: Error) => err.message);
    await vi.waitFor(() => expect(client.written).toHaveLength(1), { interval: 5 });
    client.exit();
    expect(await first).toBe("tmux control client ended: exited (SIGTERM)");
    expect(spawned).toEqual([["tmux", "display-message", "-p", "-t", "=seat@rig:", ""]]);
    await exec.close();
  });

  it("reports a write whose client ended with its server as a spawned client does: session_not_found", async () => {
    const client = fakeClient();
    const gone = Object.assign(new Error("Command failed: tmux display-message\nno server running on /tmp/tmux-1000/default\n"),
      { execStderr: "no server running on /tmp/tmux-1000/default\n" });
    const { spawned, fallback } = fakeSpawned(() => { throw gone; });
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 1000 });
    // Connected first, then the server goes while a write waits.
    const read = exec(["tmux", "has-session", "-t", "=seat@rig"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(1), { interval: 5 });
    client.answer();
    await read;
    const adapter = new TmuxAdapter(async () => "", undefined, exec);
    const sent = adapter.sendKeys("=seat@rig:", ["Enter"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(2), { interval: 5 });
    client.exit();
    expect(await sent).toMatchObject({ ok: false, code: "session_not_found" });
    expect(spawned.map((argv) => argv[1])).toEqual(["display-message"]);
    await exec.close();
  });

  it("starts no client while no server runs, or one before tmux 3.2, and asks again only after a while", async () => {
    for (const server of [() => { throw new Error("no server running on /tmp/tmux-1000/default"); }, () => "3.1c\n", () => ""]) {
      const spawned: string[][] = [];
      let clock = 0;
      const exec = tmuxControlExec(async (argv) => {
        spawned.push(argv);
        return argv[1] === "list-sessions" ? server() : "";
      }, { spawnClient: () => { throw new Error("no client expected"); }, now: () => clock });
      await exec(["tmux", "has-session", "-t", "=seat@rig"]);
      await exec(["tmux", "has-session", "-t", "=seat@rig"]);
      clock = 1_000;
      await exec(["tmux", "has-session", "-t", "=seat@rig"]);
      expect(spawned.map((argv) => argv[1])).toEqual(["list-sessions", "has-session", "has-session", "list-sessions", "has-session"]);
      await exec.close();
    }
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

  it("never runs a delete-buffer again once written: it may have taken effect", async () => {
    const client = fakeClient();
    const { spawned, fallback } = fakeSpawned();
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 1000 });
    const deleted = exec(["tmux", "delete-buffer", "-b", "b1"]).then(() => null, (err: Error) => err.message);
    await vi.waitFor(() => expect(client.written).toHaveLength(1), { interval: 5 });
    client.exit();
    expect(await deleted).toBe("tmux control client ended: exited (SIGTERM)");
    expect(spawned).toEqual([]);
    await exec.close();
  });

  it("spawns a chain again only when none of its writes was written; one written fails the call, its prefix not run again", async () => {
    for (const [argv, outcome] of [
      // The client ends once the read is answered: the send-keys was never written, so the chain is spawned whole.
      [["tmux", "display-message", "-p", "-t", "=s:", "x", ";", "send-keys", "-t", "=s:", "Enter"], "spawned"],
      // The client ends once the send-keys is answered: it ran, so the read after it fails the call instead.
      [["tmux", "send-keys", "-t", "=s:", "Enter", ";", "display-message", "-p", "-t", "=s:", "x"], "failed"],
    ] as const) {
      const client = fakeClient();
      const { spawned, fallback } = fakeSpawned(() => "spawned\n");
      const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, replyTimeoutMs: 1000 });
      const run = exec([...argv]).then(() => "spawned", (err: Error) => (err.message.includes("before the command was written") ? "failed" : err.message));
      await vi.waitFor(() => expect(client.written).toHaveLength(1));
      client.child.stdout.once("data", client.exit);
      client.answer("x");
      expect(await run).toBe(outcome);
      expect(client.written).toHaveLength(1);
      expect(spawned.filter((a) => a[1] !== "display-message" || a.length > 6)).toEqual(outcome === "spawned" ? [[...argv]] : []);
      await exec.close();
    }
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

  it("makes a session of its own as its client attaches, named and marked for this daemon, and never takes one over", async () => {
    const clients = [fakeClient({ attach: false }), fakeClient()];
    const args: string[][] = [];
    const { spawned, fallback } = fakeSpawned(() => "spawned\n");
    let clock = 0;
    const exec = tmuxControlExec(fallback, {
      spawnClient: (a) => { args.push(a); return clients[args.length - 1]!.child; }, owner: "d4e5", now: () => clock, replyTimeoutMs: 1000,
    });
    expect(exec.owner).toBe("d4e5");
    const first = exec(["tmux", "has-session", "-t", "=seat@rig"]);
    await vi.waitFor(() => expect(args).toHaveLength(1));
    expect(args[0]).toEqual(["-C", "new-session", "-s", "openrig-control-d4e5", "-x", "80", "-y", "24", "-f", "no-output,ignore-size",
      "--", "sh", "-c", "while :; do sleep 86400; done",
      ";", "set-option", "@openrig-control", "d4e5", ";", "set-option", "destroy-unattached", "on", ";", "set-option", "detach-on-destroy", "on"]);
    // Its name is taken (a session of someone else's, or one left by a daemon with the same id): tmux makes nothing,
    // and nothing is adopted. The command is spawned, and a client tried again only later.
    clients[0]!.child.stdout.write("%begin 1 1 0\nduplicate session: openrig-control-d4e5\n%error 1 1 0\n");
    expect(await first).toBe("spawned\n");
    expect(clients[0]!.kill).toHaveBeenCalled();
    expect(await exec(["tmux", "has-session", "-t", "=seat@rig"])).toBe("spawned\n");
    expect(args).toHaveLength(1);
    clock = 1_000;
    const read = exec(["tmux", "has-session", "-t", "=seat@rig"]);
    await vi.waitFor(() => expect(clients[1]!.written).toHaveLength(1));
    clients[1]!.answer();
    expect(await read).toBe("");
    expect(spawned.map((argv) => argv[1])).toEqual(["has-session", "has-session"]);
    await exec.close();
    expect(clients[1]!.kill).toHaveBeenCalled();
  });

  it("closed while its client attaches, ends that client, then spawns what it is given", async () => {
    const client = fakeClient({ attach: false });
    const { spawned, fallback } = fakeSpawned(() => "spawned\n");
    let started = 0;
    const exec = tmuxControlExec(fallback, { spawnClient: () => { started++; return client.child; }, replyTimeoutMs: 1000 });
    const read = exec(["tmux", "has-session", "-t", "=seat@rig"]);
    await vi.waitFor(() => expect(started).toBe(1));
    const closing = exec.close();
    client.attach();
    await closing;
    expect(client.kill).toHaveBeenCalled();
    expect(await read).toBe("spawned\n");
    expect(await exec(["tmux", "has-session", "-t", "=seat@rig"])).toBe("spawned\n");
    expect(spawned).toHaveLength(2);
    expect(started).toBe(1);
    expect(client.written).toEqual([]);
  });

  it("leaves out of a listing only the rows of its own session and client, once it has one", async () => {
    const client = fakeClient();
    const { fallback } = fakeSpawned((argv) => argv[1] === "list-sessions" ? "seat@rig\nopenrig-control-other\n" : "");
    const exec = tmuxControlExec(fallback, { spawnClient: () => client.child, owner: "d4e5", replyTimeoutMs: 1000 });
    const read = exec(["tmux", "has-session", "-t", "=seat@rig"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    client.answer();
    await read;
    const listing = exec(["tmux", "list-sessions", "-F", "#{session_name}"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(2));
    expect(client.written[1]).toBe("'list-sessions' '-F' '#{?#{==:#{@openrig-control},d4e5},openrig-control-d4e5:,}#{session_name}'");
    client.answer("openrig-control-d4e5:openrig-control-d4e5", "seat@rig", "openrig-control", "openrig-control-other");
    expect(await listing).toBe("seat@rig\nopenrig-control\nopenrig-control-other\n");
    await exec.close();
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

  it("marks its own rows in each listing's format, on its owner's mark, and drops only those rows", () => {
    const own = "#{?#{==:#{@openrig-control},d4e5},openrig-control-d4e5:,}";
    expect(markOwnRows(["list-sessions", "-F", "#{session_name}"], "d4e5")).toEqual(["list-sessions", "-F", `${own}#{session_name}`]);
    expect(markOwnRows(["list-panes", "-a", "-F", "x"], "d4e5")).toEqual(["list-panes", "-a", "-F", `${own}x`]);
    expect(markOwnRows(["list-clients", "-F", "x", ";", "list-windows", "-a", "-F", "y"], "d4e5"))
      .toEqual(["list-clients", "-F", `${own}x`, ";", "list-windows", "-a", "-F", `${own}y`]);
    expect(markOwnRows(["display-message", "-p", "-F", "x"], "d4e5")).toEqual(["display-message", "-p", "-F", "x"]);
    expect(markOwnRows(["capture-pane", "-p", "-t", "=s:;", "list-sessions"], "d4e5")).toEqual(["capture-pane", "-p", "-t", "=s:;", "list-sessions"]);
    expect(withoutOwnRows("openrig-control-d4e5:a\nb\nopenrig-control-d4e5:c\n", "d4e5")).toBe("b\n");
    expect(withoutOwnRows("openrig-control-ffff:a\nopenrig-control\n", "d4e5")).toBe("openrig-control-ffff:a\nopenrig-control\n");
  });
});
