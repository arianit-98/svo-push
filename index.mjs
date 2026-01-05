import fs from "fs";
import ical from "node-ical";
import { DateTime } from "luxon";
import admin from "firebase-admin";

const TZ = "Europe/Berlin";

// ====== Einstellungen ======
const WINDOW_MINUTES = 4;          // Zeitfenster, in dem gesendet wird (±4 min)
const LOOKAHEAD_DAYS = 180;        // wie weit wir nach vorne schauen
const STATE_PATH = "./state.json";

// Teams / ICS-Feeds
const FEEDS = [
  {
    teamKey: "herren",
    teamLabel: "Herren",
    ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1325866.ics"
  },
  {
    teamKey: "c1",
    teamLabel: "C1-Jugend",
    ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1345071.ics"
  }
];

// Topics pro Team + Offset
const TOPICS = {
  herren: { d4: "team_herren_d4", d1: "team_herren_d1", h1: "team_herren_h1" },
  c1:     { d4: "team_c1_d4",     d1: "team_c1_d1",     h1: "team_c1_h1" }
};

// Offsets, die du als Presets anbietest
const OFFSETS = [
  { key: "d4", minus: { days: 4 }, prefix: "In 4 Tagen" },
  { key: "d1", minus: { days: 1 }, prefix: "Morgen" },
  { key: "h1", minus: { hours: 1 }, prefix: "In 1 Stunde" }
];

// ====== Firebase Admin init ======
if (!process.env.FIREBASE_SA_B64) {
  console.error("Missing env FIREBASE_SA_B64");
  process.exit(1);
}

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// ====== State laden ======
let state = { sent: {} };
if (fs.existsSync(STATE_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.sent ||= {};
  } catch {
    state = { sent: {} };
  }
}

function wasSent(id) {
  return !!state.sent[id];
}
function markSent(id) {
  state.sent[id] = true;
}
function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function norm(s) {
  return (s || "").toString().replace(/\s+/g, " ").trim();
}

// ====== Event Parsing / Message ======
function extractOpponent(summary, teamLabel) {
  // versucht Gegner halbwegs schön zu extrahieren, bleibt aber robust
  // Beispiele: "SVO Obrigheim - TV X", "TV X - SVO Obrigheim", "SVO Obrigheim vs TV X"
  const s = norm(summary);
  if (!s) return "";

  // split candidates
  const splitters = [" - ", " vs ", " Vs ", " VS ", " : "];
  for (const sp of splitters) {
    if (s.includes(sp)) {
      const [a, b] = s.split(sp).map(norm);
      // wenn TeamLabel vorkommt, nimm die andere Seite als Gegner
      const aHas = a.toLowerCase().includes(teamLabel.toLowerCase());
      const bHas = b.toLowerCase().includes(teamLabel.toLowerCase());
      if (aHas && !bHas) return b;
      if (bHas && !aHas) return a;
      // sonst: gib beide an
      return `${a} vs ${b}`;
    }
  }
  return s;
}

function formatKickoff(dt) {
  return dt.setZone(TZ).toFormat("dd.LL.yyyy HH:mm");
}

function makeNotification(feed, ev) {
  const start = DateTime.fromJSDate(ev.start, { zone: TZ });
  const summary = norm(ev.summary || "Spiel");
  const location = norm(ev.location || "");
  const opponent = extractOpponent(summary, feed.teamLabel);

  return { start, summary, location, opponent };
}

// ====== Senden ======
async function sendToTopic(topic, title, body, data = {}) {
  await admin.messaging().send({
    topic,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]))
  });
}

// ====== Hauptlauf ======
(async () => {
  const now = DateTime.now().setZone(TZ);
  // 🔴 TEMP TEST — NUR FÜR MANUELLEN PUSH-TEST
  const FORCE_TEST_PUSH = true;

// 👉 Zielzeitpunkt: 05.01.2026 15:15 Europe/Berlin
  const FORCE_TIME = new Date("2026-01-05T15:30:00+01:00");

  const lookahead = now.plus({ days: LOOKAHEAD_DAYS });

  console.log(`Now: ${now.toISO()} (${TZ}), window ±${WINDOW_MINUTES}min`);

  for (const feed of FEEDS) {
    console.log(`Loading ICS for ${feed.teamKey}...`);
    const cal = await ical.async.fromURL(feed.ics);

    for (const item of Object.values(cal)) {
      if (!item || item.type !== "VEVENT" || !item.start) continue;

      const { start, summary, location, opponent } = makeNotification(feed, item);
      if (start < now.minus({ hours: 6 })) continue;       // vergangenes ignorieren
      if (start > lookahead) continue;                     // zu weit weg ignorieren

      for (const off of OFFSETS) {
        const fireAt = start.minus(off.minus);
        const diffMin = fireAt.diff(now, "minutes").minutes;

        if (diffMin < -WINDOW_MINUTES || diffMin > WINDOW_MINUTES) continue;

        // eindeutige ID: team + offset + kickoff ISO + summary
        const id = `${feed.teamKey}|${off.key}|${start.toISO()}|${summary}`;

        if (wasSent(id)) {
          // schon gesendet
          continue;
        }

        const topic = TOPICS[feed.teamKey][off.key];

        const title = `${off.prefix}: ${feed.teamLabel}`;
        const when = formatKickoff(start);
        const bodyParts = [];

        if (opponent) bodyParts.push(opponent);
        else bodyParts.push(summary);

        bodyParts.push(when);
        if (location) bodyParts.push(location);

        const body = bodyParts.join(" • ");

        console.log(`SENDING -> topic=${topic} id=${id}`);
        await sendToTopic(topic, title, body, {
          team: feed.teamKey,
          offset: off.key,
          kickoff: start.toISO(),
          summary
        });

        markSent(id);
      }
    }
  }

  saveState();
  console.log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
