// A seat's transcript capture lasts as long as its session. Before this, only a whole rig's teardown stopped it: a
// stopped seat, a removed node or pod, or a cleaned dead seat kept a rotator running `tmux capture-pane` against a
// session that no longer existed, every poll interval, until the daemon restarted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { wireTranscriptCaptureStops } from "../src/domain/transcript-capture.js";
import {
  clearAllTranscriptRotationsForTest,
  getActiveRotationCount,
  getLastCaptureAt,
  getTranscriptCaptureStats,
  startTranscriptRotation,
} from "../src/domain/transcript-rotation.js";

describe("transcript capture stops when a single session ends", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmpDir: string;
  let unwire: () => void;
  const captureAdapter = { capturePaneContent: vi.fn(async () => "recent work\n") } as unknown as TmuxAdapter;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    unwire = wireTranscriptCaptureStops(setup.eventBus);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-session-end-"));
  });

  afterEach(() => {
    unwire();
    clearAllTranscriptRotationsForTest();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function tmux() {
    const t = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    if (!t.probeSession) {
      t.probeSession = vi.fn(async (name: string) =>
        (await t.hasSession(name)) ? { state: "present" } : { state: "absent" });
    }
    return t;
  }

  function seedSeat(logicalId: string) {
    const rig = setup.rigRepo.findRigsByName("capture-rig")[0] ?? setup.rigRepo.createRig("capture-rig");
    const sessionName = `${logicalId.replace(".", "-")}@capture-rig`;
    const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    return { rig, node, sessionName };
  }

  function rotate(sessionName: string) {
    startTranscriptRotation(captureAdapter, sessionName, path.join(tmpDir, `${sessionName}.log`), { lines: 10, pollIntervalMs: 60_000 });
  }

  async function settle(sessionName: string) {
    const deadline = Date.now() + 2000;
    while (getLastCaptureAt(sessionName) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  function postSeat(verb: "stop" | "clean", seatRef: string) {
    return setup.app.request(`/api/seat/${verb}/${encodeURIComponent(seatRef)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "session end fixture" }),
    });
  }

  it("rig seat stop ends the stopped seat's capture and keeps its running sibling's", async () => {
    const stopped = seedSeat("dev.impl");
    const sibling = seedSeat("dev.qa");
    rotate(stopped.sessionName);
    rotate(sibling.sessionName);
    await settle(sibling.sessionName);
    expect(getActiveRotationCount()).toBe(2);

    tmux().hasSession.mockResolvedValue(true);
    expect((await postSeat("stop", stopped.sessionName)).status).toBe(200);

    expect(getActiveRotationCount()).toBe(1);
    expect(getTranscriptCaptureStats().rotatingSeats).toBe(1);
    expect(getLastCaptureAt(stopped.sessionName)).toBeUndefined();
    expect(getLastCaptureAt(sibling.sessionName)).toBeDefined();
  });

  it("a cleaned seat whose session exited on its own stops being captured", async () => {
    const dead = seedSeat("dev.impl");
    const sibling = seedSeat("dev.qa");
    rotate(dead.sessionName);
    rotate(sibling.sessionName);

    tmux().hasSession.mockResolvedValue(false);
    expect((await postSeat("clean", dead.sessionName)).status).toBe(200);

    expect(getActiveRotationCount()).toBe(1);
    expect(getLastCaptureAt(dead.sessionName)).toBeUndefined();
  });

  it("removing a pod ends its members' captures and keeps a seat outside the pod", async () => {
    const outside = seedSeat("lead.main");
    const rig = setup.rigRepo.findRigsByName("capture-rig")[0]!;
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    const members = (db.prepare(`
      SELECT s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND n.logical_id LIKE 'dev.%' ORDER BY n.logical_id
    `).all(rig.id) as Array<{ session_name: string }>).map((row) => row.session_name);
    expect(members).toHaveLength(2);
    for (const name of [outside.sessionName, ...members]) rotate(name);
    expect(getActiveRotationCount()).toBe(3);

    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/dev`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(getActiveRotationCount()).toBe(1);
    for (const name of members) expect(getLastCaptureAt(name)).toBeUndefined();
    await settle(outside.sessionName);
    expect(getLastCaptureAt(outside.sessionName)).toBeDefined();
  });

  it("removing a node whose session name another live seat owns keeps that owner's capture", async () => {
    const owner = seedSeat("dev.impl");
    const stale = setup.rigRepo.createRig("stale-rig");
    const staleNode = setup.rigRepo.addNode(stale.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(staleNode.id, owner.sessionName);
    rotate(owner.sessionName);

    const res = await setup.app.request(`/api/rigs/${stale.id}/nodes/dev.impl`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json() as { sessionKeptFor?: string }).sessionKeptFor).toBe("dev.impl@capture-rig");

    expect(getActiveRotationCount()).toBe(1);
  });

  it("a relaunch under the same session name captures again after the stop", async () => {
    const seat = seedSeat("dev.impl");
    rotate(seat.sessionName);
    tmux().hasSession.mockResolvedValue(true);
    expect((await postSeat("stop", seat.sessionName)).status).toBe(200);
    expect(getActiveRotationCount()).toBe(0);

    rotate(seat.sessionName);
    await settle(seat.sessionName);
    expect(getActiveRotationCount()).toBe(1);
    expect(getLastCaptureAt(seat.sessionName)).toBeDefined();
  });
});
