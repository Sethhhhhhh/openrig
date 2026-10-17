// The queue listing derives every row's delivery ledger in a few batched reads, and gives what the per-row derivation
// (deliveryOutcomeFor, which show and the sweeps keep) gives, byte for byte.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import type { HumanFragment, LoadResult } from "../src/domain/gateway/human-registry.js";

const FOUNDER = { entityId: "human-founder", class: "human", displayName: "F", address: "human-founder@external",
  connectorBindings: [{ connector: "slack", ref: "U0F", primary: true }], prefs: {} } as unknown as HumanFragment;

describe("queue list: delivery ledgers", () => {
  let db: ReturnType<typeof createDb>, repo: QueueRepository, loadRegistry: ReturnType<typeof vi.fn<() => LoadResult>>;
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    loadRegistry = vi.fn(() => ({ ok: true as const, entities: [FOUNDER] }));
    repo = new QueueRepository(db, new EventBus(db), { transport: { send: async () => ({ ok: true, verified: true }) }, loadHumanRegistry: loadRegistry });
    repo.attachOutbox(new OutboxHandler(db));
  });

  const latestKey = (id: string) => `${id}:${repo.transitionLog.latestOwnerNotificationForQitem(id)!.transitionId}`;
  const receipt = (id: string, kind: "posted" | "transport-failed", key = latestKey(id)) => repo.update({ qitemId: id, actorSession: "daemon@kernel",
    transitionNote: `slack-owner-notification-${kind} notification_key=${key} level=ALERT${kind === "posted" ? " message_ts=1.2" : " detail=http-500"}` });
  async function create(destinationSession: string, extra: Record<string, unknown> = {}): Promise<string> {
    const item = await repo.create({ sourceSession: "lead@rig", destinationSession, body: "b", summary: "s", priority: "routine",
      ...extra } as never);
    return (item as unknown as { qitemId: string }).qitemId;
  }

  /** Every ledger the derivation knows: posted, transport-failed, never-posted, a closed row's resolved notice, a row
   *  parked on the human, legacy gateway-owned nudges, a receipt of an earlier episode, and rows with none. Returns the
   *  legacy rows with no receipt. */
  async function seed(): Promise<string[]> {
    const legacyUnposted: string[] = [];
    for (let i = 0; i < 4; i++) {
      receipt(await create("human-founder@external", { humanIntent: "decision" }), "posted");
      receipt(await create("human-founder@external", { humanIntent: "decision" }), "transport-failed");
      await create("human-founder@external", { humanIntent: "decision" });
      const closed = await create("human-founder@external", { humanIntent: "decision" });
      receipt(closed, "posted");
      repo.update({ qitemId: closed, actorSession: "human-founder@external", state: "done", closureReason: "no-follow-on",
        transitionNote: "direct human reply received", ownerNotificationKind: "human-decision-resolved" } as never);
      const unposted = await create("human-founder@external", { humanIntent: "decision" });
      repo.update({ qitemId: unposted, actorSession: "human-founder@external", state: "done", closureReason: "no-follow-on",
        transitionNote: "direct human reply received", ownerNotificationKind: "human-decision-resolved" } as never);
      const parked = await create("dev@rig");
      repo.update({ qitemId: parked, actorSession: "dev@rig", state: "blocked", blockedOn: "human-founder@external", transitionNote: "needs the owner" } as never);
      receipt(parked, "posted", `${parked}:0`);
      const legacy = await create("dev@rig");
      repo.recordNudgeAttempt(legacy, "gateway-owned: slack");
      receipt(legacy, "transport-failed", "none");
      // No owner history and no receipt: only last_nudge_result (a compact column) makes it never-posted. Created
      // without its wake, which would overwrite that result.
      const noReceipt = await create("dev@rig", { nudge: false });
      repo.recordNudgeAttempt(noReceipt, "gateway-owned: slack");
      legacyUnposted.push(noReceipt);
      await create("dev@rig");
    }
    db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-1 hour')").run();
    db.prepare("UPDATE queue_items SET ts_created = datetime('now', '-1 hour')").run();
    return legacyUnposted;
  }

  /** The listing as the per-row derivation builds it: each item's own fields, then its ledger's. */
  function perRow<T extends { qitemId: string; deliveryOutcome?: unknown; deliveryFailureDetail?: unknown }>(items: T[]): unknown[] {
    return items.map(({ deliveryOutcome: _outcome, deliveryFailureDetail: _detail, ...item }) => {
      const ledger = repo.deliveryOutcomeFor(item.qitemId);
      return { ...item, deliveryOutcome: ledger?.outcome ?? null, ...(ledger && ledger.outcome !== "posted" ? { deliveryFailureDetail: ledger.detail } : {}) };
    });
  }

  it("gives each row the ledger deliveryOutcomeFor gives it, byte for byte", async () => {
    const legacyUnposted = await seed();
    const items = repo.list({ limit: 1000 });
    expect(items).toHaveLength(36);
    expect(new Set(items.map((item) => item.deliveryOutcome))).toEqual(new Set(["posted", "transport-failed", "never-posted", null]));
    expect(JSON.stringify(items)).toBe(JSON.stringify(perRow(items)));
    const compact = repo.list({ limit: 1000, compact: true });
    expect(compact.map((item) => [item.qitemId, item.deliveryOutcome, (item as { deliveryFailureDetail?: string }).deliveryFailureDetail]))
      .toEqual(items.map((item) => [item.qitemId, item.deliveryOutcome, item.deliveryFailureDetail]));
    expect(compact.filter((item) => legacyUnposted.includes(item.qitemId)).map((item) => item.deliveryOutcome))
      .toEqual(["never-posted", "never-posted", "never-posted", "never-posted"]);
  });

  it("reads the ledgers of a whole listing with statements prepared once, and the human registry once", async () => {
    await seed();
    repo.list({ limit: 1000, compact: true });
    const prepare = vi.spyOn(db, "prepare");
    loadRegistry.mockClear();
    const ledgerReads = () => prepare.mock.calls.filter(([sql]) => /slack-owner-notification|owner_notification_level IS NOT NULL/.test(sql));
    repo.list({ limit: 1000, compact: true });
    expect(ledgerReads()).toEqual([]);
    expect(loadRegistry).toHaveBeenCalledTimes(1);
    // The full rows' waiting view still asks, for a pending row only, whether its ask was posted to its human.
    const pending = repo.list({ limit: 1000 }).filter((item) => item.state === "pending").length;
    expect(ledgerReads().filter(([sql]) => sql.includes("slack-owner-notification")).length).toBeLessThanOrEqual(pending);
    prepare.mockRestore();
  });
});
