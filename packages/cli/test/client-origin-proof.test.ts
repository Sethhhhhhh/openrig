import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, rememberSelfHostId, SENDER_IDENTITY_HEADER } from "../src/client.js";

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
});
