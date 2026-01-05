import fs from "fs";
import ical from "node-ical";
import { DateTime } from "luxon";
import admin from "firebase-admin";

const TZ = "Europe/Berlin";
const STATE_PATH = "./state.json";

// ====== Scheduler Einstellungen ======
const WINDOW_MINUTES = 4;
const LOOKAHEAD_DAYS = 180;

// Teams / ICS-Feeds
const FEEDS = [
  {
    teamKey: "herren",
    teamLabel: "Herren",
    clubShort: "SVO",
    homeVenueHints: ["Obrigheim", "Neckarhalle"],
    ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1325866.ics"
  },
  {
    teamKey: "c1",
    teamLabel: "C1-Jugend",
    clubShort: "JSG",
    homeVenueHints: ["Obrigheim", "Neckarhalle"],
    ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1345071.ics"
  }
];

// Topics pro Team + Offset
const TOPICS = {
  herren: { d4: "team_herren_d4", d1: "team_herren_d1", h1: "team_herren_h1" },
  c1:     { d4: "team_c1_d4",     d1: "team_c1_d1",     h1: "team_c1_h1" }
};

// Offsets (Presets)
const OFFSETS = [
  { key: "d4", minus: { days: 4 } },
  { key: "d1", minus: { days: 1 } },
  { key: "h1", minus: { hours: 1 } }
];

// ====== Force-Push (für Tests) ======
const FORCE_PUSH_AT = (process.env.FORCE_PUSH_AT || "").trim();
const FORCE_PUSH_TOPIC = (process.env.FORCE_PUSH_TOPIC || "").trim();
const FORCE_PUSH_TITLE = (process.env.FORCE_PUSH_TITLE || "").trim();
const FORCE_PUSH_BODY = (process.env.FORCE_PUSH_BODY || "").trim();

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
} else {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
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

function containsIgnoreCase(haystack, needle) {
  return (haystack || "").toLowerCase().includes((needle || "").toLowerCase());
}

function cleanupTeamName(name) {
  // macht Gegnernamen etwas sauberer
  return norm(name)
    .replace(/\s{2,}/g, " ")
    .replace(/^-\s*/, "")
    .replace(/\s*-\s*$/, "");
}

function splitMatchup(summary) {
  const s = norm(summary);
  if (!s) return null;

  // typische Trenner im Handball-Kontext
  const splitters = [" - ", " vs. ", " vs ", " VS ", " : "];
  for (const sp of splitters) {
    if (s.includes(sp)) {
      const parts = s.split(sp).map(norm);
      if (parts.length >= 2) {
        return { left: parts[0], right: parts[1] };
      }
    }
  }
  return null;
}

function isHomeByVenue(location, homeHints = []) {
  const loc = norm(location);
  if (!loc) return false;
  return homeHints.some((h) => containsIgnoreCase(loc, h));
}

function determineHomeAway(feed, summary, location) {
  // Primär: aus dem Matchup (links/rechts)
  const matchup = splitMatchup(summary);
  const club = feed.clubShort;

  if (matchup) {
    const leftHasClub = containsIgnoreCase(matchup.left, club) || containsIgnoreCase(matchup.left, "SVO") || containsIgnoreCase(matchup.left, "Obrigheim");
    const rightHasClub = containsIgnoreCase(matchup.right, club) || containsIgnoreCase(matchup.right, "SVO") || containsIgnoreCase(matchup.right, "Obrigheim");

    if (leftHasClub && !rightHasClub) return "home";
    if (rightHasClub && !leftHasClub) return "away";
  }

  // Fallback: Ort/Halle-Hints
  if (isHomeByVenue(location, feed.homeVenueHints)) return "home";

  // Default: unbekannt → als Auswärts behandeln (konservativ)
  return "away";
}

function extractOpponentName(feed, summary, homeAway) {
  const matchup = splitMatchup(summary);
  const club = feed.clubShort;

  if (matchup) {
    const left = cleanupTeamName(matchup.left);
    const right = cleanupTeamName(matchup.right);

    if (homeAway === "home") {
      // Gegner ist rechts (typisch: SVO - Gegner)
      return cleanupTeamName(
        right
          .replace(new RegExp(club, "ig"), "")
          .replace(/SVO/ig, "")
          .replace(/Obrigheim/ig, "")
      ).trim() || right;
    } else {
      // Gegner ist links (typisch: Gegner - SVO)
      return cleanupTeamName(
        left
          .replace(new RegExp(club, "ig"), "")
          .replace(/SVO/ig, "")
          .replace(/Obrigheim/ig, "")
      ).trim() || left;
    }
  }

  // Fallback: ganze Summary als Gegner (nicht perfekt, aber besser als leer)
  return cleanupTeamName(summary);
}

function formatTime(dt) {
  return dt.setZone(TZ).toFormat("HH:mm");
}

function formatLine2(dt, location) {
  const time = `${formatTime(dt)} Uhr`;
  const loc = norm(location);
  if (!loc) return time;
  return `${time} - ${loc}`;
}

function makeTitle(feed, homeAway) {
  const team = feed.teamLabel;
  if (homeAway === "home") return `⏱ ${team} Heimspiel 💛💙`;
  return `⏱ ${team} Auswärtsspiel 💛💙`;
}

function makeBody(feed, homeAway, opponent, dt, location) {
  const club = feed.clubShort; // Herren: SVO, Jugend: JSG

  const line1 =
    homeAway === "home"
      ? `${club} vs. ${opponent}`
      : `${opponent} vs. ${club}`;

  const line2 = formatLine2(dt, location);

  // Body als 2 Zeilen
  return `${line1}\n${line2}`;
}

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
  const lookahead = now.plus({ days: LOOKAHEAD_DAYS });

  console.log(`Now: ${now.toISO()} (${TZ}), window ±${WINDOW_MINUTES}min`);

  // 0) FORCE PUSH (falls gesetzt)
  if (FORCE_PUSH_AT && FORCE_PUSH_TOPIC) {
    const forceAt = DateTime.fromISO(FORCE_PUSH_AT, { zone: TZ });
    if (forceAt.isValid) {
      const diffMin = forceAt.diff(now, "minutes").minutes;
      const within = diffMin >= -WINDOW_MINUTES && diffMin <= WINDOW_MINUTES;

      const forceId = `force|${FORCE_PUSH_TOPIC}|${forceAt.toISO()}|${FORCE_PUSH_TITLE}|${FORCE_PUSH_BODY}`;

      if (within && !wasSent(forceId)) {
        console.log(`FORCE SENDING -> topic=${FORCE_PUSH_TOPIC} at=${forceAt.toISO()}`);
        await sendToTopic(
          FORCE_PUSH_TOPIC,
          FORCE_PUSH_TITLE || "⏱ TEST",
          FORCE_PUSH_BODY || "TEST Push ✅",
          { kind: "force_test", at: forceAt.toISO() }
        );
        markSent(forceId);
        saveState();
        console.log("FORCE push done");
      } else {
        console.log(`FORCE not sent (withinWindow=${within}, alreadySent=${wasSent(forceId)})`);
      }
    } else {
      console.log("FORCE_PUSH_AT invalid ISO, skipping force push");
    }
  }

  // 1) NORMALER SCHEDULER (ICS)
  for (const feed of FEEDS) {
    console.log(`Loading ICS for ${feed.teamKey}...`);
    const cal = await ical.async.fromURL(feed.ics);

    for (const item of Object.values(cal)) {
      if (!item || item.type !== "VEVENT" || !item.start) continue;

      const start = DateTime.fromJSDate(item.start, { zone: TZ });
      const summary = norm(item.summary || "Spiel");
      const location = norm(item.location || "");

      if (start < now.minus({ hours: 6 })) continue;
      if (start > lookahead) continue;

      const homeAway = determineHomeAway(feed, summary, location);
      const opponent = extractOpponentName(feed, summary, homeAway);

      for (const off of OFFSETS) {
        const fireAt = start.minus(off.minus);
        const diffMin = fireAt.diff(now, "minutes").minutes;

        if (diffMin < -WINDOW_MINUTES || diffMin > WINDOW_MINUTES) continue;

        // Dedupe-ID (verhindert doppelte Pushes)
        const id = `${feed.teamKey}|${off.key}|${start.toISO()}|${summary}|${homeAway}`;
        if (wasSent(id)) continue;

        const topic = TOPICS[feed.teamKey][off.key];

        const title = makeTitle(feed, homeAway);
        const body = makeBody(feed, homeAway, opponent, start, location);

        console.log(`SENDING -> topic=${topic} id=${id}`);
        await sendToTopic(topic, title, body, {
          kind: "match",
          team: feed.teamKey,
          offset: off.key,
          kickoff: start.toISO(),
          homeAway,
          opponent,
          location,
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
