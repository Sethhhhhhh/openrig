import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, rememberSelfHostId, SENDER_IDENTITY_HEADER } from "../src/client.js";
import { getDaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => "host-local" }));

// Each test talks to its own endpoint: remembered ids live for the whole process.
let port = 17000;
const endpoint = (): string => `http://127.0.0.1:${++port}`;

function recordingFetch(selfHostId: string): { fetchImpl: typeof fetch; urls: string[]; sessions: string[] } {
  const urls: string[] = [];
  const sessions: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    const session = (init?.headers as Record<string, string> | undefined)?.[SENDER_IDENTITY_HEADER];
    if (session) sessions.push(session);
    const body = url.endsWith("/healthz") ? { selfHostId } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, urls, sessions };
}

/** The deps of a status probe on `OPENRIG_URL`: only its /healthz answer matters. */
function statusDeps(fetch: LifecycleDeps["fetch"]): LifecycleDeps {
  const unused = (): never => { throw new Error("not used by a status probe"); };
  return {
    fetch,
    sleep: async () => {},
    spawn: unused,
    kill: unused,
    readFile: () => null,
    writeFile: unused,
    removeFile: unused,
    exists: () => false,
    mkdirp: unused,
    openForAppend: unused,
    isProcessAlive: () => false,
  };
}

const answering = (body: unknown): LifecycleDeps["fetch"] => async () => ({ ok: true, json: async () => body });

describe("a seat's locality proof on a direct endpoint", () => {
  beforeEach(() => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "qa@rig");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("asks /healthz when this process has not read the endpoint's id", async () => {
    const url = endpoint();
    vi.stubEnv("OPENRIG_URL", url);
    const seen = recordingFetch("host-local");
    await new DaemonClient(url, { fetchImpl: seen.fetchImpl }).get("/api/queue/list");
    expect(seen.urls).toEqual([`${url}/healthz`, `${url}/api/queue/list`]);
    expect(seen.sessions).toEqual(["qa@rig"]);
  });

  it("reuses the id the status probe remembered, and sends the bare session when it matches", async () => {
    const url = endpoint();
    vi.stubEnv("OPENRIG_URL", url);
    rememberSelfHostId(`${url}/`, "host-local");
    const seen = recordingFetch("host-local");
    await new DaemonClient(url, { fetchImpl: seen.fetchImpl }).get("/api/queue/list");
    expect(seen.urls).toEqual([`${url}/api/queue/list`]);
    expect(seen.sessions).toEqual(["qa@rig"]);
  });

  it("carries this host's origin when the remembered id is another instance's", async () => {
    const url = endpoint();
    vi.stubEnv("OPENRIG_URL", url);
    rememberSelfHostId(url, "host-forwarded");
    const seen = recordingFetch("host-forwarded");
    await new DaemonClient(url, { fetchImpl: seen.fetchImpl }).get("/api/queue/list");
    expect(seen.urls).toEqual([`${url}/api/queue/list`]);
    expect(seen.sessions).toEqual(["qa@rig@host-local"]);
  });

  const laterProbes: Array<[string, LifecycleDeps["fetch"]]> = [
    ["fails", async () => { throw new Error("connect ECONNREFUSED"); }],
    ["answers an error", async () => ({ ok: false })],
    ["answers without an id", answering({ status: "ok" })],
  ];

  it.each(laterProbes)("forgets the remembered id when a later status probe %s", async (_, laterFetch) => {
    const url = endpoint();
    vi.stubEnv("OPENRIG_URL", url);
    await getDaemonStatus(statusDeps(answering({ selfHostId: "host-local" })));
    const before = recordingFetch("host-forwarded");
    await new DaemonClient(url, { fetchImpl: before.fetchImpl }).get("/api/queue/list");
    expect(before.urls).toEqual([`${url}/api/queue/list`]);

    // The endpoint now leads to another instance: its clients prove their locality again.
    await getDaemonStatus(statusDeps(laterFetch));
    const after = recordingFetch("host-forwarded");
    await new DaemonClient(url, { fetchImpl: after.fetchImpl }).get("/api/queue/list");
    expect(after.urls).toEqual([`${url}/healthz`, `${url}/api/queue/list`]);
    expect(after.sessions).toEqual(["qa@rig@host-local"]);
  });
});
