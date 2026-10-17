import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execArgvCommand } from "../src/adapters/tmux-exec.js";
import { CONTROL_OPTION, CONTROL_SESSION, supportsControlMode, tmuxControlExec, withoutControlSession } from "../src/adapters/tmux-control.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TmuxDiscoveryScanner } from "../src/domain/tmux-discovery-scanner.js";

const version = (() => {
  try { return execFileSync("tmux", ["-V"], { encoding: "utf8" }); } catch { return ""; }
})();

/** What a spawned tmux gives for argv: its stdout, or its error's message and stderr. */
async function outcome(exec: (argv: string[]) => Promise<string>, argv: string[]): Promise<unknown> {
  try {
    return { stdout: await exec(argv) };
  } catch (err) {
    const e = err as Error & { execStderr?: string };
    return { message: e.message.replace(/^Command failed: \S*tmux /, "Command failed: tmux "), execStderr: e.execStderr };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!supportsControlMode(version))("tmux control mode against a real server", () => {
  let dir: string;
  let control: ReturnType<typeof tmuxControlExec>;
  /** What the control exec handed to a spawned client. */
  let spawned: string[][];
  const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openrig-control-"));
    vi.stubEnv("TMUX_TMPDIR", dir);
    vi.stubEnv("TMUX", "");
    // A pane that prints what an agent could: UTF-8, a tab, a line that reads like the end of a control block.
    writeFileSync(join(dir, "screen.txt"), "héllo wörld 日本\nа\tb\n%end 1792181738 374 1\n%error 1 2 3\nlast line\n");
    tmux("new-session", "-d", "-s", "seat@rig", "-x", "120", "-y", "30", `cat ${join(dir, "screen.txt")}; exec cat`);
    spawned = [];
    control = tmuxControlExec((argv) => { spawned.push(argv); return execArgvCommand(argv); });
  });

  afterEach(async () => {
    await control.close();
    try { tmux("kill-server"); } catch { /* already gone */ }
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const reads: string[][] = [
    ["tmux", "has-session", "-t", "=seat@rig"],
    ["tmux", "has-session", "-t", "=nope@rig"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "#{pane_in_mode}|#{pane_current_command}|#{pane_width}"],
    ["tmux", "capture-pane", "-p", "-t", "=seat@rig:", "-S", "-20"],
    ["tmux", "capture-pane", "-p", "-e", "-J", "-t", "=seat@rig:", "-S", "-20"],
    ["tmux", "capture-pane", "-p", "-t", "=nope@rig:"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "__marker_1__", ";", "capture-pane", "-p", "-t", "=seat@rig:", "-S", "-2"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "__marker_1__", ";", "capture-pane", "-p", "-t", "=nope@rig:", ";", "capture-pane", "-p", "-t", "=seat@rig:"],
    ["tmux", "list-sessions", "-F", "#{session_name}|#{session_attached}"],
    ["tmux", "list-windows", "-a", "-F", "#{session_name}|#{window_index}|#{window_activity_flag}"],
    ["tmux", "list-panes", "-a", "-F", "#{session_name}|#{pane_id}|#{pane_current_command}"],
    ["tmux", "list-panes", "-t", "=seat@rig:", "-F", "#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_active}"],
    ["tmux", "show-environment", "-t", "=seat@rig"],
    // An argument ending in ; ends its command; one ending in \; keeps a literal ;; empty commands are skipped.
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "abc;", "display-message", "-p", "-t", "=seat@rig:", "second"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "abc\\;"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "abc\\\\;"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "\\;", ";", ";", "display-message", "-p", "-t", "=seat@rig:", "a;b;"],
    ["tmux", "display-message", "-p", "-t", "=seat@rig:", "x", ";"],
  ];

  it("gives every read the spawned client's stdout, error text and execStderr", async () => {
    await sleep(300);
    await control(["tmux", "has-session", "-t", "=seat@rig"]); // connects: the control session exists from here on
    const connecting = spawned.length;
    for (const argv of reads) {
      const expected = await outcome(execArgvCommand, withoutControlSession(argv));
      expect(await outcome(control, argv), argv.join(" ")).toEqual(expected);
    }
    // Every one of them went through the control client.
    expect(spawned.slice(connecting)).toEqual([]);
  });

  it("answers each command with its own output while a user's after-hook prints blocks between them", async () => {
    tmux("set-hook", "-g", "after-list-panes", "list-sessions -F hook-output");
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    const pane = tmux("display-message", "-p", "-t", "=seat@rig:", "#{pane_id}");
    const replies = await Promise.all([
      control(["tmux", "list-panes", "-t", "=seat@rig:", "-F", "#{pane_id}"]),
      control(["tmux", "display-message", "-p", "-t", "=seat@rig:", "b1"]),
      control(["tmux", "display-message", "-p", "-t", "=seat@rig:", "b2"]),
    ]);
    expect(replies).toEqual([pane, "b1\n", "b2\n"]);
    expect(await control(["tmux", "display-message", "-p", "-t", "=seat@rig:", "c1"])).toBe("c1\n");
  });

  it("leaves its own session out of every listing, and the adapter its client out of the clients", async () => {
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    expect(tmux("list-sessions", "-F", "#{session_name}")).toContain(CONTROL_SESSION);
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("seat@rig\n");
    expect(await control(["tmux", "list-panes", "-a", "-F", "#{session_name}"])).toBe("seat@rig\n");
    expect(tmux("list-clients", "-F", "#{client_session}")).toContain(CONTROL_SESSION);
    expect(await new TmuxAdapter(async () => "", undefined, control).listClients()).toEqual([]);
  });

  it("knows its session by its mark, not its name: renamed, it stays out of listings, with or without the control client", async () => {
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    tmux("rename-session", "-t", `=${CONTROL_SESSION}`, "renamed");
    expect(tmux("show-options", "-v", "-t", "=renamed:", CONTROL_OPTION).trim()).toBe("1");
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("seat@rig\n");
    expect(await control(["tmux", "list-windows", "-a", "-F", "#{session_name}"])).toBe("seat@rig\n");
    for (const exec of [control, execArgvCommand]) {
      const adapter = new TmuxAdapter(async () => "", undefined, exec);
      expect((await adapter.listSessions()).map((s) => s.name)).toEqual(["seat@rig"]);
      expect(await adapter.listClients()).toEqual([]);
      expect((await new TmuxDiscoveryScanner({ tmuxAdapter: adapter }).scan()).panes.map((p) => p.tmuxSession)).toEqual(["seat@rig"]);
    }
    // The daemon's stop kills it by id, whatever its name, and leaves every other session.
    await control.close();
    expect(tmux("list-sessions", "-F", "#{session_name}")).toBe("seat@rig\n");
  });

  it("marks a control session an older daemon made, and kills it when it stops", async () => {
    tmux("new-session", "-d", "-s", CONTROL_SESSION, "-x", "80", "-y", "24");
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    expect(tmux("show-options", "-v", "-t", `=${CONTROL_SESSION}:`, CONTROL_OPTION).trim()).toBe("1");
    expect(await new TmuxAdapter(async () => "", undefined, execArgvCommand).listSessions()).toHaveLength(1);
    await control.close();
    expect(tmux("list-sessions", "-F", "#{session_name}")).toBe("seat@rig\n");
    // Closed, it spawns what it is given and starts no client again.
    expect(await control(["tmux", "has-session", "-t", "=seat@rig"])).toBe("");
    expect(tmux("list-sessions", "-F", "#{session_name}")).toBe("seat@rig\n");
  });

  it("runs its keep-alive without a shell of the user's: what default-shell names is never started", async () => {
    const shell = join(dir, "shell.sh");
    writeFileSync(shell, `#!/bin/sh\ntouch ${join(dir, "shell-ran")}\nexec sh "$@"\n`, { mode: 0o755 });
    tmux("set-option", "-g", "default-shell", shell);
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    expect(tmux("display-message", "-p", "-t", `=${CONTROL_SESSION}:`, "#{pane_current_command}").trim()).toBe("sh");
    expect(existsSync(join(dir, "shell-ran"))).toBe(false);
  });

  it("writes into the pane what a spawned client writes, whatever the text holds", async () => {
    tmux("new-session", "-d", "-s", "typed@rig", "-x", "200", "-y", "10", "exec cat");
    await vi.waitFor(() => expect(tmux("display-message", "-p", "-t", "=typed@rig:", "#{pane_current_command}").trim()).toBe("cat"),
      { timeout: 5000, interval: 50 });
    const text = "it's $HOME ; #{session_name} ~root \\ é {braces} -t --";
    const file = join(dir, "paste.txt");
    writeFileSync(file, text);
    await control(["tmux", "load-buffer", "-b", "b1", file]);
    await control(["tmux", "paste-buffer", "-t", "=typed@rig:", "-b", "b1", "-d", "-r"]);
    await control(["tmux", "send-keys", "-t", "=typed@rig:", "Enter"]);
    // cat echoes each line it reads: the typed line, then cat's copy. Its copy is awaited before the next line is typed,
    // else the two can interleave on the screen.
    const lines = (count: number) => vi.waitFor(() => {
      const pane = tmux("capture-pane", "-p", "-t", "=typed@rig:");
      expect(pane.split("\n").filter((l) => l.includes("braces")), pane).toEqual(Array<string>(count).fill(text));
    }, { timeout: 5000, interval: 100 });
    await lines(2);
    await control(["tmux", "send-keys", "-t", "=typed@rig:", "-l", text]);
    await control(["tmux", "send-keys", "-t", "=typed@rig:", "Enter"]);
    await lines(4);
  });

  it("keeps working when its client or its session is killed, and comes back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    tmux("kill-session", "-t", `=${CONTROL_SESSION}`);
    await vi.waitFor(async () => expect(await control(["tmux", "has-session", "-t", "=seat@rig"])).toBe(""));
    expect(await control(["tmux", "list-sessions", "-F", "#{session_name}"])).toBe("seat@rig\n");
    vi.setSystemTime(Date.now() + 60_000);
    await control(["tmux", "has-session", "-t", "=seat@rig"]);
    expect(tmux("list-sessions", "-F", "#{session_name}")).toContain(CONTROL_SESSION);
    vi.useRealTimers();
  });

  it("starts no server of its own and spawns what it does not route", async () => {
    tmux("kill-server");
    const spawned: string[][] = [];
    const exec = tmuxControlExec(async (argv) => { spawned.push(argv); return execArgvCommand(argv); });
    await expect(exec(["tmux", "has-session", "-t", "=seat@rig"])).rejects.toThrow(/no server running|error connecting/);
    expect(() => tmux("list-sessions")).toThrow();
    expect(spawned.map((a) => a[1])).toEqual(["-V", "set-option", "has-session"]);
    exec.close();
  });
});
