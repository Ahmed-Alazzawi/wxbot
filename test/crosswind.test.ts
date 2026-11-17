import { describe, expect, it } from "vitest";
import { parseAirport, parseDeclination, runwayWinds, windComponents } from "../src/crosswind";
import { crosswindEmbed } from "../src/format";
import { parseMetar } from "../src/metar";

// Trimmed copy of the real record for San Diego from aviationweather.gov.
const KSAN = {
  icaoId: "KSAN",
  name: "SAN DIEGO/SAN DIEGO INTL ",
  magdec: "11E",
  runways: [{ id: "09/27", dimension: "9401x200", surface: "A", alignment: 106 }],
};

// An airport with crossing runways, to test picking the best one.
const CROSSING = {
  icaoId: "KXYZ",
  name: "TEST FIELD",
  magdec: "0E",
  runways: [
    { id: "18/36", dimension: "8000x150", alignment: 180 },
    { id: "09L/27R", dimension: "6000x100", alignment: 90 },
    { id: "H1", dimension: "50x50", alignment: "-" },
  ],
};

describe("windComponents", () => {
  it.each([
    // wind from, speed, runway heading -> headwind, crosswind, side
    [270, 10, 270, 10, 0, null], // straight down the runway
    [90, 10, 270, -10, 0, null], // straight tailwind
    [360, 10, 270, 0, 10, "right"], // direct crosswind from the right
    [180, 10, 270, 0, 10, "left"], // direct crosswind from the left
    [300, 20, 270, 17, 10, "right"], // 30 degrees off: cos 30 = 0.87, sin 30 = 0.5
    [240, 20, 270, 17, 10, "left"],
    [10, 15, 350, 14, 5, "right"], // wraps around north
    [350, 15, 10, 14, 5, "left"],
    [150, 37, 180, 32, 18, "left"], // left and right must round the same way
    [210, 37, 180, 32, 18, "right"],
  ] as const)("wind %s° at %s kt on heading %s°", (from, speed, heading, headwind, crosswind, side) => {
    expect(windComponents(from, speed, heading)).toEqual({
      headwindKt: headwind,
      crosswindKt: crosswind,
      crosswindFrom: side,
    });
  });
});

describe("parseAirport", () => {
  it("reads runways and builds both ends from the true heading", () => {
    const airport = parseAirport(KSAN);
    expect(airport.name).toBe("SAN DIEGO/SAN DIEGO INTL");
    expect(airport.runways).toEqual([
      {
        id: "09/27",
        lengthFt: 9401,
        ends: [
          { name: "09", headingTrue: 106 },
          { name: "27", headingTrue: 286 },
        ],
      },
    ]);
  });

  it("skips helipads and keeps L/C/R suffixes", () => {
    const airport = parseAirport(CROSSING);
    expect(airport.runways.map((r) => r.id)).toEqual(["18/36", "09L/27R"]);
    expect(airport.runways[1].ends[1]).toEqual({ name: "27R", headingTrue: 270 });
  });

  it("estimates the heading from the runway number and declination when it's missing", () => {
    const airport = parseAirport({ icaoId: "KXYZ", magdec: "11E", runways: [{ id: "09/27", alignment: null }] });
    // Runway 09 = 090 magnetic, plus 11 degrees east declination = 101 true.
    expect(airport.runways[0].ends.map((e) => e.headingTrue)).toEqual([101, 281]);
  });

  it("copes with missing or malformed data", () => {
    expect(parseAirport({}).runways).toEqual([]);
    expect(parseAirport(null).runways).toEqual([]);
    expect(parseAirport({ runways: [{ id: "garbage" }, { id: "N/S" }] }).runways).toEqual([]);
  });

  it("parses magnetic declination", () => {
    expect(parseDeclination("11E")).toBe(11);
    expect(parseDeclination("4W")).toBe(-4);
    expect(parseDeclination("--")).toBe(0);
    expect(parseDeclination(undefined)).toBe(0);
  });
});

describe("runwayWinds", () => {
  const wind = (raw: string) => parseMetar(`METAR KXYZ 170451Z ${raw} 10SM CLR 18/14 A2997`).wind!;

  it("picks the runway end facing into the wind", () => {
    const [result] = runwayWinds(parseAirport(KSAN), wind("29008KT"));
    expect(result.end.name).toBe("27");
    expect(result.steady).toEqual({ headwindKt: 8, crosswindKt: 1, crosswindFrom: "right" });
    expect(result.gust).toBeNull();
  });

  it("uses the other end when the wind reverses", () => {
    const [result] = runwayWinds(parseAirport(KSAN), wind("10012KT"));
    expect(result.end.name).toBe("09");
    expect(result.steady.headwindKt).toBe(12);
  });

  it("sorts runways with the smallest crosswind first and adds gust numbers", () => {
    const results = runwayWinds(parseAirport(CROSSING), wind("20020G30KT"));
    expect(results.map((r) => r.end.name)).toEqual(["18", "27R"]);
    expect(results[0].steady).toEqual({ headwindKt: 19, crosswindKt: 7, crosswindFrom: "right" });
    expect(results[0].gust).toEqual({ headwindKt: 28, crosswindKt: 10, crosswindFrom: "right" });
    expect(results[1].steady).toEqual({ headwindKt: 7, crosswindKt: 19, crosswindFrom: "left" });
  });

  it("returns nothing for calm or variable wind", () => {
    expect(runwayWinds(parseAirport(KSAN), wind("00000KT"))).toEqual([]);
    expect(runwayWinds(parseAirport(KSAN), wind("VRB03KT"))).toEqual([]);
  });
});

describe("crosswind output", () => {
  const build = (windGroup: string, airportData: unknown = KSAN) => {
    const metar = parseMetar(`METAR KSAN 170451Z ${windGroup} 10SM FEW008 18/14 A2997`);
    const airport = parseAirport(airportData);
    return crosswindEmbed(airport, metar, metar.wind ? runwayWinds(airport, metar.wind) : []);
  };

  it("describes each runway", () => {
    const embed = build("29008KT");
    expect(embed.title).toBe("KSAN crosswind · SAN DIEGO/SAN DIEGO INTL");
    expect(embed.description).toContain("**Wind:** from 290° at 8 kt");
    expect(embed.description).toContain("**Runway 27** (09/27, 9,401 ft)\nheadwind 8 kt, crosswind 1 kt from the right");
  });

  it("adds gust numbers and marks the best runway when there are several", () => {
    const embed = build("20020G30KT", CROSSING);
    expect(embed.description).toContain("In gusts: headwind 28 kt, crosswind 10 kt from the right");
    expect(embed.description).toContain("*Best aligned with the wind*");
  });

  it("explains calm, variable and missing wind", () => {
    expect(build("00000KT").description).toContain("The wind is calm");
    expect(build("VRB04KT").description).toContain("up to 4 kt of crosswind");
    expect(build("/////KT").description).toContain("no wind reading");
  });

  it("says so when the airport has no usable runway data", () => {
    expect(build("29008KT", { icaoId: "KSAN", runways: [] }).description).toContain("No runway data");
  });
});
