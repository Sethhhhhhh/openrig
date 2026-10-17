import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** One OS process, as `ps -Ao pid,ppid,pgid,tpgid,ucomm,lstart,command` prints it in the C locale. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
  pgid: number;
  tpgid: number;
  executableName: string;
  /** lstart, in local time: the identity half of pid + start time. */
  startedAt: string;
  command: string;
}

let inFlight: Promise<ProcessTableRow[]> | null = null;

/**
 * The OS process table, every observer's one source: read from /proc on Linux, where a `ps` would cost the daemon a
 * fork of its whole process, and from one `ps` elsewhere. Callers asking while a read is in flight share it; a later
 * call reads again, so two samples taken one after the other stay two observations. Rejects when the table cannot be
 * read.
 */
export function readProcessTable(): Promise<ProcessTableRow[]> {
  inFlight ??= (process.platform === "linux" ? readProcTable() : readPsTable()).finally(() => { inFlight = null; });
  return inFlight;
}

const PS_ROW = /^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/;

async function readPsTable(): Promise<ProcessTableRow[]> {
  // lstart is locale-formatted; the child-only C locale keeps the English date the parser expects.
  const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid,pgid,tpgid,ucomm,lstart,command"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
  return stdout.split("\n").slice(1).flatMap((line) => {
    // ucomm may contain spaces on every platform: macOS app helpers (`Slack Helper`), and on
    // Linux task names set by prctl(PR_SET_NAME) or process.title (`tmux: server`,
    // `node (vitest 1)`). lstart always begins with a weekday word and runs to the year, and
    // ucomm (16 bytes at most) is too short to contain such a date, so matching ucomm lazily
    // up to the first date is exact.
    const match = line.trim().match(PS_ROW);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), executableName: match[5]!, startedAt: match[6]!, command: match[7]! }] : [];
  });
}

// USER_HZ, the unit of /proc's start times: 100 on every architecture Node runs on.
const TICKS_PER_SECOND = 100;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ps's lstart (ctime's layout, local time): `Fri Oct  6 09:05:01 2026`. */
function lstart(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

/** What ps prints of a name or command line: a control character is a `.`. (In the C locale ps also prints each
 *  byte of a non-ASCII character as `?`; this keeps the text.) */
function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ".");
}

/** Pids read between two turns of the event loop: some 2 ms of reads at ~40 µs a pid. */
const PIDS_PER_SLICE = 50;

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The process table read from /proc (`root` for tests): the rows ps would print, without a process of its own. Each
 *  pid's two files are read synchronously, where as many asynchronous reads cost ten times that in the thread pool, as
 *  much CPU as the `ps` they replace; but the listing is asynchronous and the event loop is handed back every
 *  PIDS_PER_SLICE pids, so a host with thousands of processes never stalls the daemon for the whole table. */
export async function readProcTable(root = "/proc"): Promise<ProcessTableRow[]> {
  const pids = (await readdir(root)).filter((entry) => /^\d+$/.test(entry));
  const bootTime = Number(/^btime (\d+)$/m.exec(readFileSync(`${root}/stat`, "utf8"))?.[1]);
  if (!Number.isFinite(bootTime)) throw new Error(`${root}/stat has no btime`);
  const rows: ProcessTableRow[] = [];
  for (let i = 0; i < pids.length; i++) {
    if (i > 0 && i % PIDS_PER_SLICE === 0) await nextTurn();
    const row = readProcRow(root, pids[i]!, bootTime);
    if (row) rows.push(row);
  }
  return rows;
}

function readProcRow(root: string, pid: string, bootTime: number): ProcessTableRow | null {
  let stat: string;
  let cmdline: string;
  try {
    stat = readFileSync(`${root}/${pid}/stat`, "utf8");
    cmdline = readFileSync(`${root}/${pid}/cmdline`, "utf8");
  } catch {
    return null; // exited between the listing and the read
  }
  // `pid (comm) state ppid pgrp session tty_nr tpgid …`: comm may hold spaces and parentheses, so fields count from
  // its last `)`; the start time is the 22nd field, in ticks since boot.
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  if (close < 0 || fields.length < 20) return null;
  const name = printable(stat.slice(stat.indexOf("(") + 1, close));
  // A kernel thread or a zombie has no command line: ps shows its name in brackets.
  const command = printable(cmdline.replace(/[\0\n]/g, " ")).trim()
    || `[${name}]${fields[0] === "Z" ? " <defunct>" : ""}`;
  return {
    pid: Number(pid),
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    tpgid: Number(fields[5]),
    // The kernel may give a worker thread a longer name; ucomm is the task name's 15 bytes.
    executableName: Buffer.from(name).subarray(0, 15).toString(),
    startedAt: lstart(bootTime + Math.floor(Number(fields[19]) / TICKS_PER_SECOND)),
    command,
  };
}
