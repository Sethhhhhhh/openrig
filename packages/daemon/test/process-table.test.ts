import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readProcessTable, readProcTable } from "../src/domain/process-table.js";
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";
import { defaultListProcessesStrict } from "../src/domain/resume-metadata-refresher.js";

let scratch: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A /proc of its own: `btime`, then each pid's stat line and cmdline bytes. */
function fakeProc(btime: number, processes: Record<number, { stat: string; cmdline: string }>): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "process-table-"));
  fs.writeFileSync(path.join(scratch, "stat"), `cpu  1 2 3\nintr 0\nbtime ${btime}\nprocesses 9\n`);
  fs.mkdirSync(path.join(scratch, "self"));
  for (const [pid, { stat, cmdline }] of Object.entries(processes)) {
    fs.mkdirSync(path.join(scratch, pid));
    fs.writeFileSync(path.join(scratch, pid, "stat"), stat);
    fs.writeFileSync(path.join(scratch, pid, "cmdline"), cmdline);
  }
  return scratch;
}

/** A stat line: the fields after comm, from state to the start time (field 22, in ticks). */
const stat = (pid: number, comm: string, state: string, ppid: number, pgrp: number, tpgid: number, ticks: number) =>
  `${pid} (${comm}) ${state} ${ppid} ${pgrp} ${pgrp} 34816 ${tpgid} 4194560 1 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 1000 200 18446744073709551615\n`;

describe("readProcTable", () => {
  it("gives the rows ps prints: brackets for a process without a command line, ps's escapes, lstart in local time", async () => {
    vi.stubEnv("TZ", "UTC");
    const btime = Date.UTC(2026, 9, 6, 9, 0, 0) / 1000;
    const root = fakeProc(btime, {
      1: { stat: stat(1, "systemd", "S", 0, 1, -1, 1234), cmdline: "/sbin/init\0splash\0" },
      2: { stat: stat(2, "kworker/u32:4-events_unbound", "I", 0, 0, -1, 0), cmdline: "" },
      40: { stat: stat(40, "tmux: server (x)", "S", 1, 40, -1, 30_150), cmdline: "tmux\0new-session\0-d\0" },
      41: { stat: stat(41, "claude", "S", 40, 41, 41, 360_000), cmdline: "claude\0--resume\0tok-1\0a\tb\0x\ny\0é\0\0" },
      42: { stat: stat(42, "sh", "Z", 40, 41, 41, 360_099), cmdline: "" },
    });
    expect((await readProcTable(root)).sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, tpgid: -1, executableName: "systemd", startedAt: "Tue Oct  6 09:00:12 2026", command: "/sbin/init splash" },
      { pid: 2, ppid: 0, pgid: 0, tpgid: -1, executableName: "kworker/u32:4-e", startedAt: "Tue Oct  6 09:00:00 2026", command: "[kworker/u32:4-events_unbound]" },
      { pid: 40, ppid: 1, pgid: 40, tpgid: -1, executableName: "tmux: server (x", startedAt: "Tue Oct  6 09:05:01 2026", command: "tmux new-session -d" },
      { pid: 41, ppid: 40, pgid: 41, tpgid: 41, executableName: "claude", startedAt: "Tue Oct  6 10:00:00 2026", command: "claude --resume tok-1 a.b x y é" },
      { pid: 42, ppid: 40, pgid: 41, tpgid: 41, executableName: "sh", startedAt: "Tue Oct  6 10:00:00 2026", command: "[sh] <defunct>" },
    ]);
  });

  it("rejects when there is no process table to read", async () => {
    await expect(readProcTable(path.join(os.tmpdir(), "openrig-no-proc-here"))).rejects.toThrow();
  });

  it.runIf(process.platform === "linux")("reads this process as ps does, start time included", async () => {
    const rows = await readProcTable();
    const self = rows.find((row) => row.pid === process.pid)!;
    const ps = (columns: string) => execFileSync("ps", ["-o", columns, "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
    expect(self).toMatchObject({ ppid: Number(ps("ppid=")), pgid: Number(ps("pgid=")), tpgid: Number(ps("tpgid=")), executableName: ps("ucomm="), command: ps("args=") });
    expect(self.startedAt).toBe(ps("lstart="));
  });
});

describe("readProcessTable", () => {
  it("shares one read among the callers that ask while it runs, and reads again after", async () => {
    const first = readProcessTable();
    expect(readProcessTable()).toBe(first);
    await first;
    const second = readProcessTable();
    expect(second).not.toBe(first);
    await second;
  });

  it.runIf(process.platform === "linux")("spawns no ps for either lister on Linux", async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "process-table-ps-"));
    const marker = path.join(scratch, "ps-ran");
    fs.writeFileSync(path.join(scratch, "ps"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    vi.stubEnv("PATH", scratch);
    expect((await listNativeProcesses()).some((row) => row.pid === process.pid)).toBe(true);
    expect((await defaultListProcessesStrict()).some((row) => row.pid === process.pid)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });
});
