import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { fetchRawMetars, normalizeStationId } from "../src/weather";
import { allStationStates, allSubscriptions } from "../src/store";
import { clearTestDb, createTestDb } from "./helpers";

// We generate our own key pair so the tests can sign requests the way Discord does.
let publicKeyHex: string;
let privateKey: CryptoKey;
let db: D1Database;
let disposeDb: () => Promise<void>;

const toHex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKeyHex = toHex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  ({ db, dispose: disposeDb } = await createTestDb());
});
afterAll(() => disposeDb());
beforeEach(() => clearTestDb(db));

afterEach(() => vi.unstubAllGlobals());

async function signedRequest(payload: unknown, tamper = false): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = "1700000000";
  const signature = toHex(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(timestamp + body)),
  );
  return new Request("https://bot.example/", {
    method: "POST",
    headers: {
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: tamper ? body + " " : body,
  });
}

const metarCommand = (airport: string) => ({
  type: 2,
  data: { name: "metar", options: [{ name: "airport", value: airport }] },
});

const call = (req: Request) =>
  worker.fetch(req, { DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_BOT_TOKEN: "test-token", DB: db });

describe("request verification", () => {
  it("answers Discord's PING with a PONG", async () => {
    const res = await call(await signedRequest({ type: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("rejects a request whose body was changed after signing", async () => {
    const res = await call(await signedRequest({ type: 1 }, true));
    expect(res.status).toBe(401);
  });

  it("rejects a request with no signature", async () => {
    const res = await call(new Request("https://bot.example/", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("/metar", () => {
  it("returns the decoded METAR as an embed that includes the raw text", async () => {
    const raw = "METAR KSAN 170151Z 08004KT 10SM BKN025 18/17 A2997";
    const fetchMock = vi.fn(async (_url: string) => new Response(raw + "\n"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(await signedRequest(metarCommand("ksan")));
    const reply = (await res.json()) as any;

    expect(reply.type).toBe(4);
    const embed = reply.data.embeds[0];
    expect(embed.title).toBe("KSAN · MVFR");
    expect(embed.description).toContain("broken clouds at 2,500 ft");
    expect(embed.description).toContain(raw);
    expect(String(fetchMock.mock.calls[0][0])).toContain("ids=KSAN");
  });

  it("falls back to the raw text when the report can't be decoded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("this is not a weather report")));
    const res = await call(await signedRequest(metarCommand("KSAN")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toContain("this is not a weather report");
  });

  it("says so when the station has no report", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const res = await call(await signedRequest(metarCommand("KZZZ")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toContain("No recent METAR");
  });

  it("rejects input that isn't an airport code without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(await signedRequest(metarCommand("not an airport")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toContain("doesn't look like an airport code");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles the weather API being down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    const res = await call(await signedRequest(metarCommand("KSAN")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toContain("weather service is slow or not responding");
  });
});

const command = (name: string, airport: string) => ({
  type: 2,
  data: { name, options: [{ name: "airport", value: airport }] },
});

describe("/taf", () => {
  it("returns the decoded forecast as an embed", async () => {
    const raw = "TAF KSAN 170520Z 1706/1812 25015G25KT 4SM SHRA BKN020\n  FM171600 22015G25KT P6SM VCSH BKN025";
    const fetchMock = vi.fn(async (_url: string) => new Response(raw));
    vi.stubGlobal("fetch", fetchMock);

    const res = await call(await signedRequest(command("taf", "ksan")));
    const reply = (await res.json()) as any;

    expect(String(fetchMock.mock.calls[0][0])).toContain("/taf?ids=KSAN");
    expect(reply.data.embeds[0].title).toBe("KSAN forecast");
    expect(reply.data.embeds[0].description).toContain("rain showers");
  });

  it("explains when an airport has no forecast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const res = await call(await signedRequest(command("taf", "KMYF")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toContain("No forecast (TAF) found");
  });
});

describe("/crosswind", () => {
  const airportJson = JSON.stringify([
    { icaoId: "KSAN", name: "SAN DIEGO/SAN DIEGO INTL ", magdec: "11E", runways: [{ id: "09/27", dimension: "9401x200", alignment: 106 }] },
  ]);
  const stubApi = (metar: Response, airport: Response) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).includes("/airport?") ? airport : metar)),
    );

  it("combines the current wind with runway data", async () => {
    stubApi(new Response("METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997"), new Response(airportJson));
    const res = await call(await signedRequest(command("crosswind", "KSAN")));
    const reply = (await res.json()) as any;
    expect(reply.data.embeds[0].description).toContain("**Runway 27**");
    expect(reply.data.embeds[0].description).toContain("headwind 8 kt");
  });

  it("says so when there is no runway data", async () => {
    stubApi(new Response("METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997"), new Response("[]"));
    const res = await call(await signedRequest(command("crosswind", "KSAN")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toContain("No runway data");
  });

  it("says so when there is no METAR", async () => {
    stubApi(new Response(null, { status: 204 }), new Response(airportJson));
    const res = await call(await signedRequest(command("crosswind", "KSAN")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toContain("No recent METAR");
  });
});

describe("alert commands", () => {
  // What Discord sends for a command used in a server the bot was added to.
  const inServer = (name: string, options: Record<string, string>, userId = "u1", channelId = "c1") => ({
    type: 2,
    guild_id: "g1",
    channel_id: channelId,
    context: 0,
    authorizing_integration_owners: { "0": "g1" },
    member: { user: { id: userId } },
    data: { name, options: Object.entries(options).map(([n, value]) => ({ name: n, value })) },
  });
  const stubMetar = (raw: string | null) =>
    vi.stubGlobal("fetch", vi.fn(async () => (raw ? new Response(raw) : new Response(null, { status: 204 }))));
  const content = async (payload: unknown) => ((await (await call(await signedRequest(payload))).json()) as any).data.content;

  it("/subscribe saves the alert, defaults to IFR and records the current category", async () => {
    stubMetar("METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997");
    const text = await content(inServer("subscribe", { airport: "ksan" }));
    expect(text).toContain("**KSAN** changes to IFR or worse");
    expect(text).toContain("Right now it's VFR.");
    expect(await allSubscriptions(db)).toMatchObject([{ userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" }]);
    expect((await allStationStates(db)).get("KSAN")?.category).toBe("VFR");
  });

  it("/subscribe accepts a chosen condition and updates an existing alert", async () => {
    stubMetar("METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997");
    await content(inServer("subscribe", { airport: "KSAN" }));
    await content(inServer("subscribe", { airport: "KSAN", condition: "MVFR" }));
    expect(await allSubscriptions(db)).toMatchObject([{ threshold: "MVFR" }]);
  });

  it("/subscribe refuses an airport with no weather reports", async () => {
    stubMetar(null);
    expect(await content(inServer("subscribe", { airport: "KZZZ" }))).toContain("no weather reports");
    expect(await allSubscriptions(db)).toEqual([]);
  });

  it("/subscribe enforces the per-user limit", async () => {
    stubMetar("METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997");
    for (let i = 0; i < 10; i++) await content(inServer("subscribe", { airport: "KSAN" }, "u1", `c${i}`));
    expect(await content(inServer("subscribe", { airport: "KSAN" }, "u1", "c-extra"))).toContain("which is the limit");
    expect(await allSubscriptions(db)).toHaveLength(10);
  });

  it("/subscribe works in a DM with the bot but not where the bot can't post", async () => {
    stubMetar("METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997");
    const dm = { type: 2, channel_id: "dm1", context: 1, user: { id: "u1" }, authorizing_integration_owners: { "1": "u1" } };
    const data = { name: "subscribe", options: [{ name: "airport", value: "KSAN" }] };
    expect(await content({ ...dm, data })).toContain("Alert set");

    // Used through a personal install inside a server the bot isn't in.
    const elsewhere = { ...dm, channel_id: "c9", guild_id: "g9", context: 0, member: { user: { id: "u1" } } };
    expect(await content({ ...elsewhere, data })).toContain("can't post alerts in this chat");
    // Used in a group chat.
    expect(await content({ ...dm, channel_id: "gdm", context: 2, data })).toContain("can't post alerts in this chat");
    expect(await allSubscriptions(db)).toHaveLength(1);
  });

  it("/alerts lists and /unsubscribe removes", async () => {
    stubMetar("METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997");
    expect(await content(inServer("alerts", {}))).toContain("You have no alerts");
    await content(inServer("subscribe", { airport: "KSAN", condition: "LIFR" }));
    expect(await content(inServer("alerts", {}))).toContain("• **KSAN**: LIFR, posted in <#c1>");

    expect(await content(inServer("unsubscribe", { airport: "KSAN" }, "u1", "other"))).toContain("don't have a **KSAN** alert");
    expect(await content(inServer("unsubscribe", { airport: "KSAN" }))).toContain("Removed your **KSAN** alert");
    expect(await allSubscriptions(db)).toEqual([]);
  });
});

describe("caching", () => {
  const metar = "METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997";

  it("asks the weather service once for repeated commands", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(metar));
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 3; i++) await call(await signedRequest(metarCommand("KSAN")));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different airport is a different cache entry.
    await call(await signedRequest(metarCommand("KJFK")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches again once the cached copy has expired", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(metar));
    vi.stubGlobal("fetch", fetchMock);
    await call(await signedRequest(metarCommand("KSAN")));
    await db.prepare("UPDATE api_cache SET expires_at = 0").run();
    await call(await signedRequest(metarCommand("KSAN")));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("remembers that an airport has no report", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await call(await signedRequest(metarCommand("KZZZ")));
    const res = await call(await signedRequest(metarCommand("KZZZ")));
    expect(((await res.json()) as any).data.content).toContain("No recent METAR");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    await call(await signedRequest(metarCommand("KSAN")));
    const fetchMock = vi.fn(async (_url: string) => new Response(metar));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call(await signedRequest(metarCommand("KSAN")));
    expect(((await res.json()) as any).data.embeds[0].title).toBe("KSAN · VFR");
  });

  it("still answers when the cache table is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(metar)));
    const brokenDb = { prepare: () => { throw new Error("database offline"); } } as unknown as D1Database;
    const res = await worker.fetch(await signedRequest(metarCommand("KSAN")), {
      DISCORD_PUBLIC_KEY: publicKeyHex,
      DISCORD_BOT_TOKEN: "test-token",
      DB: brokenDb,
    });
    expect(((await res.json()) as any).data.embeds[0].title).toBe("KSAN · VFR");
  });

  it("caches runway data for /crosswind", async () => {
    const airportJson = JSON.stringify([{ icaoId: "KSAN", name: "SAN DIEGO INTL", magdec: "11E", runways: [{ id: "09/27", dimension: "9401x200", alignment: 106 }] }]);
    const fetchMock = vi.fn(async (url: string) => new Response(String(url).includes("/airport?") ? airportJson : metar));
    vi.stubGlobal("fetch", fetchMock);
    await call(await signedRequest(command("crosswind", "KSAN")));
    const res = await call(await signedRequest(command("crosswind", "KSAN")));
    expect(((await res.json()) as any).data.embeds[0].description).toContain("**Runway 27**");
    expect(fetchMock).toHaveBeenCalledTimes(2); // one METAR + one airport lookup, total
  });
});

describe("weather service problems", () => {
  it("reports a timeout or network failure clearly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }));
    const res = await call(await signedRequest(metarCommand("KSAN")));
    expect(((await res.json()) as any).data.content).toContain("weather service is slow or not responding");
  });
});

describe("fetchRawMetars", () => {
  it("fetches many stations in one request and keeps the newest report for each", async () => {
    const body = [
      "SPECI KSAN 170207Z 08004KT 3SM RA BR BKN025 18/17 A2997",
      "METAR KSAN 170151Z 08004KT 10SM BKN025 18/17 A2997",
      "METAR KJFK 170251Z 34006KT 10SM FEW250 07/01 A3045",
      "",
    ].join("\n");
    const fetchMock = vi.fn(async (_url: string) => new Response(body));
    vi.stubGlobal("fetch", fetchMock);

    const reports = await fetchRawMetars(["KSAN", "KJFK", "KZZZ"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("ids=KSAN,KJFK,KZZZ");
    expect([...reports.keys()]).toEqual(["KSAN", "KJFK"]);
    expect(reports.get("KSAN")).toContain("SPECI");
  });

  it("splits long lists into several requests", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchRawMetars(Array.from({ length: 90 }, (_, i) => `K${String(i).padStart(3, "0")}`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("unknown commands", () => {
  it("replies politely", async () => {
    const res = await call(await signedRequest(command("nope", "KSAN")));
    const reply = (await res.json()) as any;
    expect(reply.data.content).toBe("Unknown command.");
  });
});

describe("normalizeStationId", () => {
  it.each([
    ["KSAN", "KSAN"],
    [" ksan ", "KSAN"],
    ["san", "KSAN"],
    ["EGLL", "EGLL"],
    ["K1A2", "K1A2"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeStationId(input)).toBe(expected);
  });

  it.each(["", "KS", "KSANN", "K-AN", "1234"])("rejects %s", (input) => {
    expect(normalizeStationId(input)).toBeNull();
  });
});
