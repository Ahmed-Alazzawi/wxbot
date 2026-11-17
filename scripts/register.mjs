/**
 * Tells Discord which slash commands the bot has.
 * Run it once now, and again whenever you add or change a command:
 *
 *   npm run register
 *
 * It reads DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN from the .dev.vars file.
 */

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;

if (!appId || !token) {
  console.error("Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN in .dev.vars");
  process.exit(1);
}

// Every command takes the same single option: an airport code.
const airportCommand = (name, description) => ({
  name,
  description,
  options: [
    {
      name: "airport",
      description: "Airport code, for example KSAN",
      type: 3, // STRING
      required: true,
    },
  ],
  // Works in servers (0) and for users who installed the app themselves (1)...
  integration_types: [0, 1],
  // ...in server channels (0), DMs with the bot (1) and other DMs (2).
  contexts: [0, 1, 2],
});

const everywhere = { integration_types: [0, 1], contexts: [0, 1, 2] };

const commands = [
  airportCommand("metar", "Current weather at an airport, decoded into plain English"),
  airportCommand("taf", "Weather forecast for an airport, decoded into plain English"),
  airportCommand("crosswind", "Headwind and crosswind on each runway right now"),
  {
    ...airportCommand("subscribe", "Get an alert here when an airport's flight conditions change"),
    options: [
      { name: "airport", description: "Airport code, for example KSAN", type: 3, required: true },
      {
        name: "condition",
        description: "Alert when conditions are this bad or worse (default: IFR)",
        type: 3,
        required: false,
        choices: [
          { name: "MVFR or worse (marginal)", value: "MVFR" },
          { name: "IFR or worse (instrument conditions)", value: "IFR" },
          { name: "LIFR only (very low)", value: "LIFR" },
        ],
      },
    ],
  },
  airportCommand("unsubscribe", "Remove your alert for an airport in this channel"),
  { name: "alerts", description: "List your weather alerts", ...everywhere },
];

const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: {
    "content-type": "application/json",
    authorization: `Bot ${token}`,
  },
  body: JSON.stringify(commands),
});

if (response.ok) {
  const registered = await response.json();
  console.log(`Registered ${registered.length} command(s): ${registered.map((c) => "/" + c.name).join(", ")}`);
} else {
  console.error(`Discord returned ${response.status}:`, await response.text());
  process.exit(1);
}
