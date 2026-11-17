import { describe, expect, it } from "vitest";
import { parseTaf, TafParseError } from "../src/taf";
import { periodHeading, summarizePeriod, tafEmbed } from "../src/format";

// "Now" for these tests: 17 Nov 2026, 05:00 UTC.
const NOW = new Date(Date.UTC(2026, 10, 17, 5, 0));
const iso = (d: Date | null) => d?.toISOString().slice(0, 16);

// Real forecasts pulled from aviationweather.gov on 17 Nov 2026 (UTC).
const EGLL = `TAF EGLL 162301Z 1700/1806 09012KT 9999 BKN015
  TEMPO 1700/1709 6000 SHRA RA BKN008
  PROB30
  TEMPO 1700/1704 10015G25KT 3000 +RA BKN004
  BECMG 1704/1707 VRB03KT
  PROB40
  TEMPO 1704/1708 2000 +SHRA +RA BKN002 BKN015CB
  BECMG 1707/1710 24016G26KT
  TEMPO 1709/1718 6000 SHRA
  PROB30
  TEMPO 1709/1718 3000 +SHRAGS
  BECMG 1716/1719 23010KT
  PROB30
  TEMPO 1722/1806 7000 SHRA`;

const KNKX = `TAF KNKX 170000Z 1700/1806 27010KT 6000 SHRA BR BKN013 OVC025 QNH2995INS
  BECMG 1703/1705 27012G22KT 9999 NSW OVC025 QNH2995INS
  FM171030 27010KT 9999 BKN040 QNH2996INS
  FM171730 27015G25KT 9999 SCT050 QNH3001INS
  BECMG 1800/1802 29006KT 9999 BKN050 QNH3004INS
  FM180300 VRB06KT 9999 BKN050 QNH3008INS TX18/1719Z TN12/1806Z`;

describe("real forecast: London Heathrow (many TEMPO and PROB groups)", () => {
  const taf = parseTaf(EGLL, NOW);

  it("reads the header", () => {
    expect(taf.station).toBe("EGLL");
    expect(iso(taf.issued)).toBe("2026-11-16T23:01");
    expect(iso(taf.validFrom)).toBe("2026-11-17T00:00");
    expect(iso(taf.validTo)).toBe("2026-11-18T06:00");
    expect(taf.unparsed).toEqual([]);
  });

  it("splits the forecast into the right periods", () => {
    expect(taf.periods.map((p) => p.kind)).toEqual([
      "BASE", "TEMPO", "PROB", "BECMG", "PROB", "BECMG", "TEMPO", "PROB", "BECMG", "PROB",
    ]);
    expect(taf.periods.map((p) => p.probability)).toEqual([null, null, 30, null, 40, null, null, 30, null, 30]);
  });

  it("handles PROB30 and TEMPO split across two lines", () => {
    const prob = taf.periods[2];
    expect(iso(prob.from)).toBe("2026-11-17T00:00");
    expect(iso(prob.to)).toBe("2026-11-17T04:00");
    expect(prob.wind).toMatchObject({ direction: 100, speedKt: 15, gustKt: 25 });
    expect(prob.weather).toEqual(["heavy rain"]);
  });

  it("gives each period a flight category, filling gaps from the prevailing conditions", () => {
    expect(taf.periods.map((p) => p.flightCategory)).toEqual([
      "MVFR", // base: ceiling 1,500 ft
      "IFR", // ceiling 800 ft
      "LIFR", // ceiling 400 ft
      "MVFR", // only the wind changes, so the base ceiling still applies
      "LIFR", // ceiling 200 ft
      "MVFR",
      "MVFR", // 6,000 m visibility, base ceiling
      "IFR", // 3,000 m visibility
      "MVFR",
      "MVFR", // 7,000 m visibility
    ]);
  });

  it("decodes combined weather codes", () => {
    expect(taf.periods[4].weather).toEqual(["heavy rain showers", "heavy rain"]);
    expect(taf.periods[4].clouds[1]).toEqual({ cover: "BKN", baseFt: 1500, type: "CB" });
    expect(taf.periods[7].weather).toEqual(["heavy rain and small hail showers"]);
  });

  it("handles a period that crosses midnight into the next day", () => {
    const last = taf.periods[9];
    expect(iso(last.from)).toBe("2026-11-17T22:00");
    expect(iso(last.to)).toBe("2026-11-18T06:00");
  });
});

describe("real forecast: MCAS Miramar (military format with FM groups)", () => {
  const taf = parseTaf(KNKX, NOW);

  it("skips military pressure and temperature groups", () => {
    expect(taf.unparsed).toEqual([]);
  });

  it("reads FM times and gives each main period an end time", () => {
    expect(taf.periods.map((p) => p.kind)).toEqual(["BASE", "BECMG", "FM", "FM", "BECMG", "FM"]);
    const [base, , fm1, fm2, , fm3] = taf.periods;
    expect(iso(base.from)).toBe("2026-11-17T00:00");
    expect(iso(base.to)).toBe("2026-11-17T10:30");
    expect(iso(fm1.from)).toBe("2026-11-17T10:30");
    expect(iso(fm1.to)).toBe("2026-11-17T17:30");
    expect(iso(fm2.to)).toBe("2026-11-18T03:00");
    expect(iso(fm3.to)).toBe("2026-11-18T06:00");
  });

  it("decodes conditions and categories", () => {
    expect(taf.periods.map((p) => p.flightCategory)).toEqual(["MVFR", "MVFR", "VFR", "VFR", "VFR", "VFR"]);
    expect(taf.periods[0].weather).toEqual(["rain showers", "mist"]);
    expect(taf.periods[1].noSignificantWeather).toBe(true);
    expect(taf.periods[3].wind).toMatchObject({ direction: 270, speedKt: 15, gustKt: 25 });
    expect(taf.periods[5].wind).toMatchObject({ direction: "VRB", speedKt: 6 });
  });
});

describe("constructed cases", () => {
  it("reads a US-style forecast with P6SM", () => {
    const taf = parseTaf(
      `TAF KSAN 170520Z 1706/1812 25015G25KT 4SM SHRA BKN020
        FM171600 22015G25KT P6SM VCSH BKN025
        FM171900 22010KT P6SM BKN035`,
      NOW,
    );
    expect(taf.periods.map((p) => p.flightCategory)).toEqual(["MVFR", "MVFR", "VFR"]);
    expect(taf.periods[1].visibility).toMatchObject({ miles: 6, modifier: "more", text: "more than 6 statute miles" });
    expect(taf.periods[1].weather).toEqual(["showers in the vicinity"]);
  });

  it("flags amended forecasts and reads PROB without TEMPO", () => {
    const taf = parseTaf("TAF AMD KDEN 170530Z 1706/1806 18008KT P6SM SKC PROB30 1710/1713 1SM BR", NOW);
    expect(taf.amended).toBe(true);
    expect(taf.periods[1]).toMatchObject({ kind: "PROB", probability: 30, flightCategory: "IFR" });
    expect(taf.periods[0].flightCategory).toBe("VFR");
  });

  it("decodes wind shear", () => {
    const taf = parseTaf("TAF KXYZ 170530Z 1706/1806 18008KT P6SM SKC WS020/22045KT", NOW);
    expect(taf.periods[0].windShear).toBe("wind shear at 2,000 ft (wind from 220° at 45 kt)");
    expect(taf.unparsed).toEqual([]);
  });

  it("a BECMG change carries forward, a TEMPO change does not", () => {
    const taf = parseTaf(
      "TAF KXYZ 170530Z 1706/1806 18008KT P6SM OVC040 TEMPO 1708/1710 OVC004 BECMG 1710/1712 OVC008 TEMPO 1714/1716 2SM",
      NOW,
    );
    // base VFR, tempo LIFR, becoming IFR, then a visibility-only tempo that keeps the 800 ft ceiling.
    expect(taf.periods.map((p) => p.flightCategory)).toEqual(["VFR", "LIFR", "IFR", "IFR"]);
    expect(taf.periods[3].categoryReason).toBe("ceiling and visibility");
  });

  it("resolves dates when the forecast runs into next month", () => {
    const taf = parseTaf("TAF KXYZ 301720Z 3018/0118 18008KT P6SM SKC FM010200 20005KT P6SM SKC", new Date(Date.UTC(2026, 10, 30, 18, 0)));
    expect(iso(taf.validTo)).toBe("2026-12-01T18:00");
    expect(iso(taf.periods[1].from)).toBe("2026-12-01T02:00");
  });

  it("throws a TafParseError for text that isn't a TAF", () => {
    expect(() => parseTaf("no forecast here", NOW)).toThrow(TafParseError);
    expect(() => parseTaf("", NOW)).toThrow(TafParseError);
  });
});

describe("forecast output", () => {
  it("summarises only what a period mentions", () => {
    const taf = parseTaf(KNKX, NOW);
    expect(summarizePeriod(taf.periods[1])).toBe(
      "wind from 270° at 12 kt, gusting 22 kt · visibility 10 km or more · no significant weather · overcast at 2,500 ft",
    );
    expect(summarizePeriod(parseTaf(EGLL, NOW).periods[3])).toBe("wind variable at 3 kt");
  });

  it("labels each kind of period", () => {
    const taf = parseTaf(EGLL, NOW);
    expect(periodHeading(taf.periods[0])).toMatch(/^From <t:\d+:t>/);
    expect(periodHeading(taf.periods[1])).toMatch(/^Temporarily, <t:\d+:t> to <t:\d+:t>/);
    expect(periodHeading(taf.periods[2])).toMatch(/^30% chance, /);
    expect(periodHeading(taf.periods[3])).toMatch(/^Becoming, /);
  });

  it("builds an embed that leaves out periods already over and colours by the worst category", () => {
    const taf = parseTaf(EGLL, NOW);
    const embed = tafEmbed(taf, NOW);
    expect(embed.title).toBe("EGLL forecast");
    // At 05:00 the 00:00-04:00 PROB30 group is over; the worst left is the PROB40 LIFR group.
    expect(embed.description).not.toContain("gusting 25 kt");
    expect(embed.description).toContain("**Worst expected:** LIFR");
    expect(embed.color).toBe(0xd63af9);
    expect(embed.description).toContain("🟣 **40% chance");
    expect(embed.description).toContain(taf.raw);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
  });

  it("stays inside Discord's size limit for a very long forecast", () => {
    const groups = Array.from({ length: 60 }, () => "TEMPO 1708/1710 24016G26KT 3000 +SHRA BKN004 BKN015CB").join(" ");
    const embed = tafEmbed(parseTaf(`TAF KXYZ 170530Z 1706/1806 18008KT P6SM SKC ${groups}`, NOW), NOW);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.description).toContain("more period(s)");
  });
});
