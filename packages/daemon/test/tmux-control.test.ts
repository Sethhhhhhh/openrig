import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ControlReplies, supportsControlMode, tmuxControlExec, withoutControlSession } from "../src/adapters/tmux-control.js";

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
  });
});

/** A control client that attaches, records the command lines written to it and answers only when told to. */
function fakeClient() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true), unref: () => {},
  });
  const written: string[] = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => written.push(...chunk.split("\n").filter(Boolean)));
  setImmediate(() => child.stdout.write("%begin 1 1 0\n%end 1 1 0\n"));
  let n = 1;
  const answer = (...lines: string[]) => { n++; child.stdout.write(`%begin 1 ${n} 1\n${lines.map((l) => `${l}\n`).join("")}%end 1 ${n} 1\n`); };
  return { child: child as unknown as ChildProcessWithoutNullStreams, kill: child.kill, written, answer };
}

describe("tmuxControlExec", () => {
  it("fails only a read that has no reply in time, keeps the client, and gives each later reply its own command", async () => {
    const client = fakeClient();
    const spawned: string[][] = [];
    const exec = tmuxControlExec(async (argv) => {
      if (argv[1] === "-V") return "tmux 3.6\n";
      if (argv[1] === "has-session") return "";
      spawned.push(argv);
      return "spawned read\n";
    }, { spawnClient: () => client.child, replyTimeoutMs: 50 });

    const slowRead = exec(["tmux", "capture-pane", "-p", "-J", "-t", "=seat@rig:", "-S", "-", "-E", "-"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(1));
    const write = exec(["tmux", "send-keys", "-t", "=seat@rig:", "Enter"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(2));
    let writeSettled = false;
    void write.finally(() => { writeSettled = true; });

    // The read is past its time: it is asked of a spawned client, and the write in flight waits for its own reply.
    expect(await slowRead).toBe("spawned read\n");
    expect(spawned.map((argv) => argv[1])).toEqual(["capture-pane"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(writeSettled).toBe(false);
    expect(client.kill).not.toHaveBeenCalled();

    client.answer("the whole history, late");
    client.answer();
    expect(await write).toBe("");
    const read = exec(["tmux", "display-message", "-p", "-t", "=seat@rig:", "x"]);
    await vi.waitFor(() => expect(client.written).toHaveLength(3));
    client.answer("x");
    expect(await read).toBe("x\n");
    expect(spawned).toHaveLength(1);
    exec.close();
  });
});

describe("control-mode rules", () => {
  it("needs tmux 3.2 or later", () => {
    expect(supportsControlMode("tmux 3.3a\n")).toBe(true);
    expect(supportsControlMode("tmux 3.2")).toBe(true);
    expect(supportsControlMode("tmux next-3.6")).toBe(true);
    expect(supportsControlMode("tmux 3.1c")).toBe(false);
    expect(supportsControlMode("tmux 2.9")).toBe(false);
    expect(supportsControlMode("psmux")).toBe(false);
  });

  it("filters only the listings of everything, and never twice", () => {
    expect(withoutControlSession(["tmux", "list-sessions", "-F", "#{session_name}"]))
      .toEqual(["tmux", "list-sessions", "-f", "#{!=:#{session_name},openrig-control}", "-F", "#{session_name}"]);
    expect(withoutControlSession(["tmux", "list-panes", "-a", "-F", "x"])[2]).toBe("-f");
    expect(withoutControlSession(["tmux", "list-windows", "-a", "-F", "x"])[2]).toBe("-f");
    expect(withoutControlSession(["tmux", "list-panes", "-t", "=s:", "-F", "x"])).toEqual(["tmux", "list-panes", "-t", "=s:", "-F", "x"]);
    expect(withoutControlSession(["tmux", "list-sessions", "-f", "#{x}"])).toEqual(["tmux", "list-sessions", "-f", "#{x}"]);
    expect(withoutControlSession(["tmux", "capture-pane", "-p", "-t", "=s:"])).toEqual(["tmux", "capture-pane", "-p", "-t", "=s:"]);
  });
});
