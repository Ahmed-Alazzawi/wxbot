import { describe, expect, it } from "vitest";
import {
  decodeWeather,
  flightCategoryFor,
  MetarParseError,
  observationTime,
  parseMetar,
  type DecodedMetar,
} from "../src/metar";
import { describeClouds, describeMetar, describeWind, metarEmbed } from "../src/format";

/**
 * Real reports pulled from aviationweather.gov on 17 Nov 2026 (UTC).
 * Each one lists the flight category worked out by hand, plus any
 * field that makes the report a tricky case.
 */
type Expected = Partial<Omit<DecodedMetar, "wind" | "visibility">> & {
  wind?: Partial<NonNullable<DecodedMetar["wind"]>>;
  visibilityMiles?: number;
  reason?: string | null;
};

const REAL_REPORTS: Array<[raw: string, category: string | null, expected: Expected]> = [
  // --- United States ---
  [
    "SPECI KSAN 170207Z 08004KT 3SM RA BR BKN025 OVC041 18/17 A2997 RMK AO2 P0003 T01780167 $",
    "MVFR",
    { type: "SPECI", weather: ["rain", "mist"], ceilingFt: 2500, reason: "ceiling and visibility" },
  ],
  [
    "METAR KSAN 170251Z 11003KT 10SM BKN021 OVC036 18/17 A2997 RMK AO2 RAE44 SLP148 P0005 60021 T01780167 53003 $",
    "MVFR",
    { ceilingFt: 2100, reason: "ceiling", tempC: 18, dewPointC: 17, altimeterInHg: 29.97 },
  ],
  [
    "METAR KACV 170253Z AUTO 05004KT 3SM RA BR FEW017 OVC036 09/08 A3010 RMK AO2 RAB25 SLP199 P0006 60006 T00940083 50003",
    "MVFR",
    { auto: true, ceilingFt: 3600, reason: "visibility", visibilityMiles: 3 },
  ],
  ["METAR KASE 170253Z AUTO 19006KT 10SM CLR 01/M04 A3018 RMK AO2 SLP200 T00061044 50002", "VFR", { skyClear: true, tempC: 1, dewPointC: -4 }],
  ["METAR KBOS 170254Z 29006KT 10SM CLR 07/M01 A3036 RMK AO2 SLP281 T00671011 50003 $", "VFR", { ceilingFt: null }],
  ["METAR KBUF 170254Z 27008KT 10SM BKN025 06/03 A3048 RMK AO2 SLP329 T00560028 53001 $", "MVFR", { ceilingFt: 2500 }],
  ["METAR KDEN 170253Z 23005KT 10SM BKN220 06/M01 A3002 RMK AO2 SLP151 T00611011 58007", "VFR", { ceilingFt: 22000 }],
  ["METAR KJFK 170251Z 34006KT 10SM FEW250 07/01 A3045 RMK SLP309 T00720006 51009 $", "VFR", { ceilingFt: null }],
  [
    // Mountain-top station: 130 mile visibility, a cloud layer with no height, no altimeter.
    "METAR KMWN 170153Z 31033KT 130SM FEW/// FEW100 M07/M22 RMK ACSL DSNT SW TPS LWR FEW045",
    "VFR",
    { visibilityMiles: 130, tempC: -7, dewPointC: -22, altimeterInHg: null, wind: { direction: 310, speedKt: 33 } },
  ],
  ["METAR KORD 170251Z 20005KT 10SM CLR 06/00 A3047 RMK AO2 SLP323 T00610000 53005 $", "VFR", { dewPointC: 0 }],
  ["METAR KSEA 170253Z 00000KT 10SM SCT050 SCT100 08/05 A3007 RMK AO2 SLP191 T00780050 53003 $", "VFR", { wind: { speedKt: 0, direction: null } }],
  ["METAR KSFO 170156Z 28006KT 10SM FEW035 FEW100 13/07 A3007 RMK AO2 SLP180 T01280072 $", "VFR", {}],
  ["METAR KTVL 170253Z AUTO 21004KT 10SM CLR M02/M04 A2998 RMK AO2 SLP154 T10221039 53007", "VFR", { tempC: -2, dewPointC: -4 }],
  ["METAR KEGE 170156Z AUTO 09008KT 10SM CLR 04/M03 A3016 RMK AO2 SLP226 T00391028", "VFR", {}],
  ["METAR KLAS 170256Z 29005KT 10SM OVC095 17/07 A2993 RMK AO2 SLP124 T01670072 57008", "VFR", { ceilingFt: 9500 }],
  [
    "METAR KMIA 170253Z 06015G23KT 10SM OVC032 24/19 A3015 RMK AO2 SLP211 60000 T02440189 58002 $",
    "VFR",
    { ceilingFt: 3200, wind: { direction: 60, speedKt: 15, gustKt: 23 } },
  ],
  ["METAR KMSP 170253Z 18005KT 10SM CLR 09/M01 A3026 RMK AO2 SLP253 T00941006 53008", "VFR", {}],
  [
    "METAR KSLE 170156Z 15003KT 10SM -RA BKN055 BKN085 OVC120 08/06 A3007 RMK AO2 RAB46 SLP184 P0000 T00780061",
    "VFR",
    { weather: ["light rain"], ceilingFt: 5500 },
  ],
  // --- Alaska and Hawaii ---
  [
    "METAR PABR 170253Z AUTO 07020KT 5SM UP BR OVC011 M08/M09 A2963 RMK AO2 PK WND 07029/0213 UPB06E12B51FZRAE06B12E51 SLP035 P0000 60000 I1000 I3002 T10781094 51004 TSNO $",
    "MVFR",
    { weather: ["unknown precipitation", "mist"], ceilingFt: 1100, reason: "ceiling and visibility" },
  ],
  [
    // Storm: strong gusts, quarter-mile visibility in fog.
    "SPECI PADK 170219Z AUTO 15037G48KT 1/4SM -RA FG BKN018 BKN025 OVC033 04/03 A2912 RMK AO2 PK WND 15048/0213 PRESFR P0011",
    "LIFR",
    {
      type: "SPECI",
      visibilityMiles: 0.25,
      weather: ["light rain", "fog"],
      reason: "visibility",
      wind: { direction: 150, speedKt: 37, gustKt: 48 },
    },
  ],
  ["METAR PAFA 170253Z 00000KT 10SM BKN037 OVC050 M04/M06 A2926 RMK AO2 SLP920 T10391056 51026 $", "VFR", { ceilingFt: 3700 }],
  ["METAR PANC 170253Z 00000KT 10SM FEW040 SCT110 M03/M03 A2921 RMK AO2 SLP893 I1000 I3000 T10331033 53038 $", "VFR", { ceilingFt: null }],
  ["METAR PHNL 170253Z 05015G20KT 10SM FEW025 BKN035 BKN065 27/20 A3008 RMK AO2 SLP185 T02670200 53001 $", "VFR", { ceilingFt: 3500 }],
  // --- Canada and Mexico ---
  ["SPECI CYFB 170220Z 11018KT 15SM BKN018 OVC037 M07/M09 A2935 RMK SC7SC1 SLP943", "MVFR", { ceilingFt: 1800 }],
  ["METAR CYVR 170200Z VRB02KT 20SM SCT085 08/05 A3006 RMK AC3 SLP183", "VFR", { wind: { direction: "VRB", speedKt: 2 } }],
  ["METAR CYYZ 170200Z 26009KT 15SM OVC017 05/02 A3047 RMK SC8 SLP326", "MVFR", { ceilingFt: 1700 }],
  ["METAR CYQX 170200Z 29011KT 20SM BKN021 M01/M03 A2988 RMK SC6 SLP128", "MVFR", {}],
  [
    // NOSIG appears before RMK here.
    "METAR MMMX 170240Z 36007KT 7SM SCT020 SCT080 BKN220 16/07 A3038 NOSIG RMK SLP157 52017 914 8/538 HZY",
    "VFR",
    { visibilityMiles: 7, ceilingFt: 22000, unparsed: [] },
  ],
  // --- International format: metres, hPa, CAVOK, trend forecasts ---
  ["METAR BIKF 170300Z 08016KT CAVOK 01/M03 Q0991", "VFR", { cavok: true, altimeterHpa: 991, altimeterInHg: 29.26 }],
  [
    "METAR EDDF 170250Z AUTO 11003KT 6000 -RADZ BKN004 BKN009 08/07 Q1000 TEMPO 4000 RA",
    "LIFR",
    { weather: ["light rain and drizzle"], ceilingFt: 400, reason: "ceiling" },
  ],
  [
    // RERA = recent rain; the TEMPO forecast after it must not be read as current weather.
    "METAR EGLL 170250Z 10013KT 4500 RA OVC004 07/06 Q0984 RERA TEMPO 6000 -RA",
    "LIFR",
    { weather: ["rain"], ceilingFt: 400, altimeterHpa: 984, unparsed: [] },
  ],
  ["METAR EHAM 170255Z 13006KT 9999 FEW035 03/02 Q0996 NOSIG", "VFR", {}],
  ["METAR ENGM 170250Z 02004KT CAVOK M03/M05 Q0995", "VFR", { cavok: true, tempC: -3 }],
  [
    // The gust in the BECMG forecast must not be read as the current wind.
    "METAR LFPG 170300Z 21015KT 9999 BKN007 OVC012 14/13 Q0992 BECMG 20015G25KT",
    "IFR",
    { ceilingFt: 700, reason: "ceiling", wind: { direction: 210, speedKt: 15, gustKt: null } },
  ],
  ["METAR LSZH 170250Z AUTO 17005KT 9999 -SHRA FEW026 BKN060 10/07 Q1003 NOSIG", "VFR", { weather: ["light rain showers"] }],
  [
    // Variable wind direction, and cloud groups with a "///" type suffix.
    "METAR NZAA 170300Z AUTO 32014KT 280V060 9999 FEW037/// OVC047/// 21/14 Q1015",
    "VFR",
    { ceilingFt: 4700, wind: { direction: 320, variableFrom: 280, variableTo: 60 } },
  ],
  ["METAR OMDB 170300Z 17004KT 9999 FEW040 23/15 Q1015 NOSIG", "VFR", {}],
  ["METAR RJTT 170230Z 36013KT 9999 -RA FEW010 BKN025 13/11 Q1024 NOSIG", "MVFR", { ceilingFt: 2500 }],
  [
    // Wind in metres per second, plus a runway state group.
    "METAR UUEE 170230Z 17006MPS 9999 BKN042 02/M03 Q1014 R24L/CLRD62 NOSIG",
    "VFR",
    { wind: { direction: 170, speedKt: 12 }, unparsed: [] },
  ],
  ["METAR VHHH 170300Z 10011KT 070V130 9999 FEW018 29/20 Q1017 NOSIG", "VFR", { wind: { variableFrom: 70, variableTo: 130 } }],
  ["METAR YSSY 170230Z 13010KT 9999 FEW040 22/13 Q1020", "VFR", {}],
  ["METAR BGSF 170250Z AUTO 24017KT 9999NDV BKN023/// OVC046/// M03/M06 Q0994", "MVFR", { ceilingFt: 2300 }],
  ["METAR EFHK 170250Z 16010KT 9999 FEW006 BKN008 04/04 Q0992 TEMPO 6000", "IFR", { ceilingFt: 800 }],
  ["METAR EGPD 170250Z COR AUTO 13009KT 9999 FEW031 SCT038 06/02 Q0992 NOSIG", "VFR", { corrected: true, auto: true }],
  ["METAR ESSA 170250Z 35007KT 9999 BKN007 03/02 Q0990 TEMPO BKN004", "IFR", { ceilingFt: 700 }],
  ["METAR FACT 170200Z 14012KT CAVOK 17/10 Q1019 NOSIG", "VFR", { cavok: true }],
  ["METAR LOWI 170250Z AUTO VRB01KT 9999 BKN080 05/02 Q1006", "VFR", { ceilingFt: 8000 }],
  ["METAR SBGR 170200Z 09003KT 9999 BKN023 20/17 Q1014", "MVFR", {}],
  [
    // 2,200 m is about 1.4 miles: IFR on visibility alone, with no cloud at all.
    "METAR VIDP 170230Z 23005KT 2200 HZ NSC 16/09 Q1016 NOSIG",
    "IFR",
    { weather: ["haze"], skyClear: true, ceilingFt: null, reason: "visibility" },
  ],
  [
    "METAR WSSS 170300Z 34004KT 310V020 9999 FEW016 FEW018TCU SCT150 31/24 Q1012 NOSIG",
    "VFR",
    { ceilingFt: null, tempC: 31 },
  ],
];

describe(`real reports (${REAL_REPORTS.length})`, () => {
  it.each(REAL_REPORTS)("%s", (raw, category, expected) => {
    const metar = parseMetar(raw);
    const { wind, visibilityMiles, reason, ...fields } = expected;

    expect(metar.station).toBe(raw.split(" ")[1]);
    expect(metar.flightCategory).toBe(category);
    expect(metar).toMatchObject(fields);
    if (wind) expect(metar.wind).toMatchObject(wind);
    if (visibilityMiles !== undefined) expect(metar.visibility?.miles).toBeCloseTo(visibilityMiles);
    if (reason !== undefined) expect(metar.categoryReason).toBe(reason);

    // Every report must also format without throwing.
    expect(metarEmbed(metar).description).toContain(raw);
  });

  it("leaves nothing unrecognised in any of them", () => {
    const leftovers = REAL_REPORTS.flatMap(([raw]) => parseMetar(raw).unparsed);
    expect(leftovers).toEqual([]);
  });
});

// Cases that weren't in the live data when the tests were written.
describe("constructed edge cases", () => {
  it("reads a whole number and fraction visibility split across two tokens", () => {
    const metar = parseMetar("METAR KXYZ 011253Z 18010KT 1 1/2SM BR OVC008 10/09 A2990");
    expect(metar.visibility?.miles).toBe(1.5);
    expect(metar.visibility?.text).toBe("1 1/2 statute miles");
    expect(metar.flightCategory).toBe("IFR");
    expect(metar.categoryReason).toBe("ceiling and visibility");
  });

  it("handles 'less than 1/4 mile' visibility and an obscured sky", () => {
    const metar = parseMetar("METAR KXYZ 011253Z 00000KT M1/4SM FZFG VV002 M01/M01 A3012");
    expect(metar.visibility).toMatchObject({ miles: 0.25, modifier: "less", text: "less than 1/4 statute mile" });
    expect(metar.weather).toEqual(["freezing fog"]);
    expect(metar.ceilingFt).toBe(200);
    expect(metar.flightCategory).toBe("LIFR");
  });

  it("decodes a thunderstorm with cumulonimbus cloud", () => {
    const metar = parseMetar("SPECI KXYZ 011253Z 24018G35KT 2SM +TSRA BKN030CB 22/20 A2975 RMK AO2");
    expect(metar.weather).toEqual(["thunderstorm with heavy rain"]);
    expect(metar.clouds[0]).toEqual({ cover: "BKN", baseFt: 3000, type: "CB" });
    expect(metar.flightCategory).toBe("IFR");
    expect(describeClouds(metar)).toBe("broken clouds at 3,000 ft (cumulonimbus)");
  });

  it("skips runway visual range groups", () => {
    const metar = parseMetar("METAR KXYZ 011253Z 09005KT 1/2SM R28L/2600FT FG VV003 08/08 A3001");
    expect(metar.unparsed).toEqual([]);
    expect(metar.visibility?.miles).toBe(0.5);
    expect(metar.flightCategory).toBe("LIFR");
  });

  it("copes with missing wind, missing dew point and missing altimeter", () => {
    const metar = parseMetar("METAR KXYZ 011253Z AUTO /////KT 10SM CLR 18/ A////");
    expect(metar.wind).toBeNull();
    expect(metar.tempC).toBe(18);
    expect(metar.dewPointC).toBeNull();
    expect(metar.altimeterInHg).toBeNull();
    expect(describeWind(metar)).toBe("not reported");
  });

  it("gives no flight category when visibility or sky condition is missing", () => {
    expect(parseMetar("METAR KXYZ 011253Z 18005KT BKN020 10/05 A2990").flightCategory).toBeNull();
    expect(parseMetar("METAR KXYZ 011253Z 18005KT 10SM 10/05 A2990").flightCategory).toBeNull();
  });

  it("works without the METAR prefix and with a trailing '='", () => {
    const metar = parseMetar("EGLL 011220Z 24008KT 9999 SCT030 12/08 Q1018=");
    expect(metar.station).toBe("EGLL");
    expect(metar.altimeterHpa).toBe(1018);
    expect(metar.flightCategory).toBe("VFR");
  });

  it("throws a MetarParseError for text that isn't a METAR", () => {
    expect(() => parseMetar("this is not a weather report")).toThrow(MetarParseError);
    expect(() => parseMetar("")).toThrow(MetarParseError);
  });
});

describe("flight category boundaries", () => {
  it.each([
    // ceiling, visibility, expected
    [null, 10, "VFR"],
    [3100, 6, "VFR"],
    [3000, 10, "MVFR"], // 3,000 ft is still MVFR
    [null, 5, "MVFR"], // 5 miles is still MVFR
    [1000, 10, "MVFR"], // 1,000 ft is MVFR, not IFR
    [null, 3, "MVFR"], // 3 miles is MVFR, not IFR
    [900, 10, "IFR"],
    [null, 2.5, "IFR"],
    [500, 10, "IFR"], // 500 ft is IFR, not LIFR
    [null, 1, "IFR"], // 1 mile is IFR, not LIFR
    [400, 10, "LIFR"],
    [null, 0.75, "LIFR"],
    [5000, 0.5, "LIFR"], // the worse of the two wins
    [200, 10, "LIFR"],
  ] as const)("ceiling %s ft, visibility %s mi -> %s", (ceiling, visibility, expected) => {
    expect(flightCategoryFor(ceiling, visibility).category).toBe(expected);
  });
});

describe("decodeWeather", () => {
  it.each([
    ["RA", "rain"],
    ["-RA", "light rain"],
    ["+SN", "heavy snow"],
    ["BR", "mist"],
    ["-SHRA", "light rain showers"],
    ["TS", "thunderstorm"],
    ["TSRA", "thunderstorm with rain"],
    ["FZRA", "freezing rain"],
    ["-FZDZ", "light freezing drizzle"],
    ["BLSN", "blowing snow"],
    ["MIFG", "shallow fog"],
    ["BCFG", "patches of fog"],
    ["VCSH", "showers in the vicinity"],
    ["VCTS", "thunderstorm in the vicinity"],
    ["RASN", "rain and snow"],
    ["+FC", "tornado or waterspout"],
    ["UP", "unknown precipitation"],
  ])("%s -> %s", (code, text) => {
    expect(decodeWeather(code)).toBe(text);
  });

  it.each(["AUTO", "KSAN", "10SM", "BKN025", "A2997", "", "-", "XX"])("rejects %s", (code) => {
    expect(decodeWeather(code)).toBeNull();
  });
});

describe("observationTime", () => {
  const metar = (day: number) => parseMetar(`METAR KSAN ${String(day).padStart(2, "0")}2351Z 00000KT 10SM CLR 18/10 A3000`);

  it("uses the current month", () => {
    const now = new Date(Date.UTC(2026, 10, 17, 3, 0));
    expect(observationTime(metar(16), now)?.toISOString()).toBe("2026-11-16T23:51:00.000Z");
  });

  it("steps back a month when the report is from the end of last month", () => {
    const now = new Date(Date.UTC(2026, 11, 1, 0, 10));
    expect(observationTime(metar(30), now)?.toISOString()).toBe("2026-11-30T23:51:00.000Z");
  });

  it("steps back across a year boundary", () => {
    const now = new Date(Date.UTC(2027, 0, 1, 0, 10));
    expect(observationTime(metar(31), now)?.toISOString()).toBe("2026-12-31T23:51:00.000Z");
  });
});

describe("plain-English output", () => {
  it("describes a full report", () => {
    const metar = parseMetar(
      "SPECI PADK 170219Z AUTO 15037G48KT 1/4SM -RA FG BKN018 BKN025 OVC033 04/03 A2912 RMK AO2",
    );
    const text = describeMetar(metar, new Date(Date.UTC(2026, 10, 17, 3, 0))).join("\n");
    expect(text).toContain("**Flight category:** LIFR: low instrument conditions, because of visibility");
    expect(text).toContain("(special report)");
    expect(text).toContain("**Wind:** from 150° at 37 kt, gusting 48 kt");
    expect(text).toContain("**Visibility:** 1/4 statute mile");
    expect(text).toContain("**Weather:** light rain, fog");
    expect(text).toContain("**Clouds:** broken clouds at 1,800 ft, broken clouds at 2,500 ft, overcast at 3,300 ft");
    expect(text).toContain("**Ceiling:** 1,800 ft");
    expect(text).toContain("**Temperature:** 4°C (39°F)");
    expect(text).toContain("**Altimeter:** 29.12 inHg (986 hPa)");
  });

  it("describes calm wind, variable wind and metric visibility", () => {
    expect(describeWind(parseMetar("KSEA 170253Z 00000KT 10SM CLR 08/05 A3007"))).toBe("calm");
    expect(describeWind(parseMetar("CYVR 170200Z VRB02KT 20SM SCT085 08/05 A3006"))).toBe("variable at 2 kt");
    expect(describeWind(parseMetar("NZAA 170300Z 32014KT 280V060 9999 FEW037 21/14 Q1015"))).toBe(
      "from 320° at 14 kt, direction varying 280° to 060°",
    );
    expect(parseMetar("VIDP 170230Z 23005KT 2200 HZ NSC 16/09 Q1016").visibility?.text).toBe("2,200 m (1.4 mi)");
    expect(parseMetar("EHAM 170255Z 13006KT 9999 FEW035 03/02 Q0996").visibility?.text).toBe("10 km or more");
  });

  it("colours the embed by flight category", () => {
    expect(metarEmbed(parseMetar("KBOS 170254Z 29006KT 10SM CLR 07/M01 A3036")).color).toBe(0x2ecc71);
    expect(metarEmbed(parseMetar("LFPG 170300Z 21015KT 9999 BKN007 14/13 Q0992")).color).toBe(0xe74c3c);
  });
});
