import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAlertCheck, shouldNotify } from "../src/alerts";
import type { SendResult } from "../src/discord";
import {
  allStationStates,
  allSubscriptions,
  deleteSubscription,
  rememberStateIfNew,
  saveSubscription,
  subscriptionsForUser,
} from "../src/store";
import { clearTestDb, createTestDb } from "./helpers";

let db: D1Database;
let dispose: () => Promise<void>;

beforeAll(async () => {
  ({ db, dispose } = await createTestDb());
});
afterAll(() => dispose());
beforeEach(() => clearTestDb(db));

// Reports for one airport in each flight category.
const REPORT = {
  VFR: "METAR KSAN 170451Z 29008KT 10SM FEW008 18/14 A2997",
  MVFR: "METAR KSAN 170551Z 29008KT 10SM BKN021 18/14 A2997",
  IFR: "METAR KSAN 170651Z 29008KT 2SM BR OVC008 18/17 A2997",
  LIFR: "METAR KSAN 170751Z 00000KT 1/4SM FG VV002 17/17 A2997",
};

describe("shouldNotify", () => {
  it.each([
    // previous, current, threshold, expected
    ["VFR", "IFR", "IFR", true], // crossed the threshold going down
    ["IFR", "VFR", "IFR", true], // crossed it coming back up
    ["IFR", "LIFR", "IFR", true], // got worse while already below
    ["LIFR", "IFR", "IFR", true], // improved but still below
    ["VFR", "MVFR", "IFR", false], // change happened entirely above the threshold
    ["MVFR", "VFR", "IFR", false],
    ["VFR", "MVFR", "MVFR", true],
    ["VFR", "IFR", "LIFR", false], // IFR isn't bad enough for a LIFR alert
    ["IFR", "LIFR", "LIFR", true],
    ["IFR", "IFR", "IFR", false], // no change, no alert
  ] as const)("%s -> %s with a %s alert: %s", (previous, current, threshold, expected) => {
    expect(shouldNotify(previous, current, threshold)).toBe(expected);
  });
});

describe("store", () => {
  it("saves, lists and deletes subscriptions", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    await saveSubscription(db, { userId: "u1", channelId: "c2", station: "KJFK", threshold: "MVFR" });
    await saveSubscription(db, { userId: "u2", channelId: "c1", station: "KSAN", threshold: "LIFR" });

    expect((await subscriptionsForUser(db, "u1")).map((s) => s.station)).toEqual(["KJFK", "KSAN"]);
    expect(await allSubscriptions(db)).toHaveLength(3);

    expect(await deleteSubscription(db, "u1", "c1", "KSAN")).toBe(true);
    expect(await deleteSubscription(db, "u1", "c1", "KSAN")).toBe(false);
    expect(await allSubscriptions(db)).toHaveLength(2);
  });

  it("updates the threshold instead of creating a duplicate", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "MVFR" });
    const subs = await subscriptionsForUser(db, "u1");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ userId: "u1", channelId: "c1", station: "KSAN", threshold: "MVFR" });
  });

  it("rejects a threshold the database doesn't allow", async () => {
    await expect(
      saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "VFR" as any }),
    ).rejects.toThrow();
  });

  it("treats input as data, not SQL", async () => {
    const nasty = "KSAN'; DROP TABLE subscriptions; --";
    await saveSubscription(db, { userId: nasty, channelId: "c1", station: "KSAN", threshold: "IFR" });
    expect((await subscriptionsForUser(db, nasty))[0].userId).toBe(nasty);
  });

  it("only records a station's state the first time", async () => {
    await rememberStateIfNew(db, { station: "KSAN", category: "VFR", raw: "a" });
    await rememberStateIfNew(db, { station: "KSAN", category: "IFR", raw: "b" });
    expect((await allStationStates(db)).get("KSAN")?.category).toBe("VFR");
  });
});

describe("runAlertCheck", () => {
  const sent: Array<{ channelId: string; payload: any }> = [];
  let sendResult: SendResult = "sent";
  const send = vi.fn(async (_token: string, channelId: string, payload: unknown) => {
    sent.push({ channelId, payload });
    return sendResult;
  });
  const run = (reports: Record<string, string>, maxSends?: number) =>
    runAlertCheck({
      db,
      botToken: "test-token",
      fetchMetars: async (stations) => new Map(stations.filter((s) => s in reports).map((s) => [s, reports[s]])),
      send,
      maxSends,
    });
  const stateOf = async (station: string) => (await allStationStates(db)).get(station)?.category;

  beforeEach(() => {
    sent.length = 0;
    sendResult = "sent";
    send.mockClear();
  });

  it("does nothing when nobody is subscribed", async () => {
    expect(await run({ KSAN: REPORT.IFR })).toEqual({ stationsChecked: 0, alertsSent: 0, channelsRemoved: 0 });
  });

  it("records the first report without alerting", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    const result = await run({ KSAN: REPORT.IFR });
    expect(result.alertsSent).toBe(0);
    expect(await stateOf("KSAN")).toBe("IFR");
  });

  it("alerts when conditions drop to the threshold, then again when they recover", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    await run({ KSAN: REPORT.VFR });

    expect((await run({ KSAN: REPORT.IFR })).alertsSent).toBe(1);
    expect(sent[0].channelId).toBe("c1");
    expect(sent[0].payload.content).toBe("<@u1>");
    expect(sent[0].payload.allowed_mentions).toEqual({ users: ["u1"] });
    expect(sent[0].payload.embeds[0].title).toBe("🔴 KSAN dropped to IFR (was VFR)");
    expect(await stateOf("KSAN")).toBe("IFR");

    // Same report again: no repeat alert.
    expect((await run({ KSAN: REPORT.IFR })).alertsSent).toBe(0);

    expect((await run({ KSAN: REPORT.VFR })).alertsSent).toBe(1);
    expect(sent[1].payload.embeds[0].title).toBe("🟢 KSAN improved to VFR (was IFR)");
  });

  it("stays quiet for changes above the threshold but still tracks them", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    await run({ KSAN: REPORT.VFR });
    expect((await run({ KSAN: REPORT.MVFR })).alertsSent).toBe(0);
    expect(await stateOf("KSAN")).toBe("MVFR");
  });

  it("sends one message per channel and only mentions people whose threshold is met", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    await saveSubscription(db, { userId: "u2", channelId: "c1", station: "KSAN", threshold: "MVFR" });
    await saveSubscription(db, { userId: "u3", channelId: "c1", station: "KSAN", threshold: "LIFR" });
    await saveSubscription(db, { userId: "u4", channelId: "c2", station: "KSAN", threshold: "IFR" });
    await run({ KSAN: REPORT.VFR });

    expect((await run({ KSAN: REPORT.IFR })).alertsSent).toBe(2);
    const c1 = sent.find((m) => m.channelId === "c1")!;
    expect(c1.payload.content).toBe("<@u1> <@u2>"); // u3 only wants LIFR
    expect(sent.find((m) => m.channelId === "c2")!.payload.content).toBe("<@u4>");
  });

  it("removes subscriptions for a channel the bot can no longer post to", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "gone", station: "KSAN", threshold: "IFR" });
    await run({ KSAN: REPORT.VFR });
    sendResult = "gone";

    const result = await run({ KSAN: REPORT.IFR });
    expect(result).toMatchObject({ alertsSent: 0, channelsRemoved: 1 });
    expect(await allSubscriptions(db)).toEqual([]);
    // With no subscribers left, the airport's state is cleaned up too.
    expect(await stateOf("KSAN")).toBeUndefined();
  });

  it("retries next run when Discord has a temporary problem", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    await run({ KSAN: REPORT.VFR });
    sendResult = "failed";
    await run({ KSAN: REPORT.IFR });
    expect(await stateOf("KSAN")).toBe("VFR"); // not updated, so the change is still pending

    sendResult = "sent";
    expect((await run({ KSAN: REPORT.IFR })).alertsSent).toBe(1);
    expect(await stateOf("KSAN")).toBe("IFR");
  });

  it("stops at the send budget and leaves the rest for the next run", async () => {
    for (const station of ["KAAA", "KBBB", "KCCC"]) {
      await saveSubscription(db, { userId: "u1", channelId: `c-${station}`, station, threshold: "IFR" });
    }
    const reports = (r: string) => ({
      KAAA: r.replace("KSAN", "KAAA"),
      KBBB: r.replace("KSAN", "KBBB"),
      KCCC: r.replace("KSAN", "KCCC"),
    });
    await run(reports(REPORT.VFR));

    expect((await run(reports(REPORT.IFR), 2)).alertsSent).toBe(2);
    expect((await run(reports(REPORT.IFR), 2)).alertsSent).toBe(1);
    expect((await run(reports(REPORT.IFR), 2)).alertsSent).toBe(0);
  });

  it("ignores missing and unreadable reports", async () => {
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KSAN", threshold: "IFR" });
    await saveSubscription(db, { userId: "u1", channelId: "c1", station: "KJFK", threshold: "IFR" });
    await run({ KSAN: REPORT.VFR, KJFK: REPORT.VFR.replace("KSAN", "KJFK") });

    // KSAN: garbage. KJFK: no report at all.
    const result = await run({ KSAN: "not a report" });
    expect(result).toMatchObject({ stationsChecked: 0, alertsSent: 0 });
    expect(await stateOf("KSAN")).toBe("VFR");
    expect(await stateOf("KJFK")).toBe("VFR");
  });
});
