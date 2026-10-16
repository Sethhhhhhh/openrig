import { describe, expect, it } from "vitest";
import { ControlReplies, supportsControlMode, withoutControlSession } from "../src/adapters/tmux-control.js";

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

  it("fails what is still waiting when the client is gone", () => {
    const r = new ControlReplies();
    const errors: string[] = [];
    r.expect({ resolve: () => {}, reject: (e) => errors.push(e.message) });
    r.failAll(new Error("gone"));
    expect(errors).toEqual(["gone"]);
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
