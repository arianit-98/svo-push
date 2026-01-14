import fs from "fs";
import dns from "dns";
import https from "https";
import axios from "axios";
import ical from "node-ical";
import { DateTime } from "luxon";
import admin from "firebase-admin";

const TZ = "Europe/Berlin";
const STATE_PATH = "./state.json";

// ====== Scheduler Einstellungen ======
const WINDOW_MINUTES = 6;      // Toleranz pro Run
const LOOKAHEAD_DAYS = 180;    // wie weit voraus wir Spiele betrachten
const FETCH_TIMEOUT_MS = 15000;

// Teams / ICS-Feeds
const FEEDS = [
  {
    teamKey: "herren",
    teamLabel: "Herren",
    clubShort: "SVO",
    homeVenueHints: ["Obrigheim", "Neckarhalle"],
    ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1325866.ics",
  },
  {
    teamKey: "c1",
    teamLabel: "C1-Jugend",
    clubShort: "JSG",
    homeVenueHints: ["Obrigheim", "Neckarhalle"],
    ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1345071.ics",
  },
];

// Topics pro Team + Offset
const TOPICS = {
  herren: { d4: "team_herren_d4", d1: "team_herren_d1", h1: "team_herren_h1" },
  c1:     { d4: "team_c1_d4",     d1: "team_c1_d1",     h1: "team_c1_h1" },
};

// Offsets (Presets)
const OFFSETS = [
  { key: "d4", minus: { days: 4 } },
  { key: "d1", minus: { days: 1 } },
  { key: "h1", minus: { hours: 1 } },
];

// ====== Force-Push (für Tests) ======
const FORCE_PUSH_AT = (process.env.FORCE_PUSH_AT || "").trim();
const FORCE_PUSH_TOPIC = (process.env.FORCE_PUSH_TOPIC || "").trim();
const FORCE_PUSH_TITLE = (process.env.FORCE_PUSH_TITLE || "").trim();
const FORCE_PUSH_BODY = (process.env.FORCE_PUSH_BODY || "").trim();

// ====== DNS/HTTP Robustness ======
// IPv4 bevorzugen (hilft oft bei sporadischen ENOTFOUND/IPv6 Problemen im Runner)
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // älteres Node ignorieren
}

// https agent mit keepAlive + lookup family=4
const httpsAgent = new https.Agent({
  keepAlive: true,
  lookup: (hostname, options, cb) => dns.lookup(hostname, { ...options, family: 4 }, cb),
});

const http = axios.create({
  httpsAgent,
  timeout: FETCH_TIMEOUT_MS,
  headers: {
    "User-Agent": "svo-push-scheduler/1.0 (+github-actions)",
    "Accept": "text/calendar,text/plain,*/*",
  },
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTextWithRetry(url, attempts = 4) {
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await http.get(url, { responseType: "text" });
      return res.data;
    } catch (e) {
      lastErr = e;

      const code = e?.cause?.code || e?.code || "";
      const status = e?.response?.status;

      console.log(`Fetch failed (${i}/${attempts}) url=${url} code=${code} status=${status || "-"}`);

      // Bei 4xx lohnt Retry meist nicht
      if (status && status >= 400 && status < 500) break;

      // Backoff
      const backoff = 1500 * i * i; // 1.5s, 6s, 13.5s, ...
      await sleep(backoff);
    }
  }

  throw lastErr;
}

// ====== Firebase Admin init ======
if (!process.env.FIREBASE_SA_B64) {
  console.error("Missing env FIREBASE_SA_B64");
  process.exit(1);
}

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ====== State laden ======
let state = { sent: {}, events: {}, meta: {} };
if (fs.existsSync(STATE_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.sent ||= {};
    state.events ||= {};
    state.meta ||= {};
  } catch {
    state = { sent: {}, events: {}, meta: {} };
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
  return norm(name)
    .replace(/\s{2,}/g, " ")
    .replace(/^-\s*/, "")
    .replace(/\s*-\s*$/, "");
}

function splitMatchup(summary) {
  const s = norm(summary);
  if (!s) return null;

  const splitters = [" - ", " vs. ", " vs ", " VS ", " : "];
  for (const sp of splitters) {
    if (s.includes(sp)) {
      const parts = s.split(sp).map(norm);
      if (parts.length >= 2) return { left: parts[0], right: parts[1] };
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
  const matchup = splitMatchup(summary);
  const club = feed.clubShort;

  if (matchup) {
    const leftHasClub =
      containsIgnoreCase(matchup.left, club) ||
      containsIgnoreCase(matchup.left, "SVO") ||
      containsIgnoreCase(matchup.left, "Obrigheim");
    const rightHasClub =
      containsIgnoreCase(matchup.right, club) ||
      containsIgnoreCase(matchup.right, "SVO") ||
      containsIgnoreCase(matchup.right, "Obrigheim");

    if (leftHasClub && !rightHasClub) return "home";
    if (rightHasClub && !leftHasClub) return "away";
  }

  if (isHomeByVenue(location, feed.homeVenueHints)) return "home";
  return "away";
}

function extractOpponentName(feed, summary, homeAway) {
  const matchup = splitMatchup(summary);
  const club = feed.clubShort;

  if (matchup) {
    const left = cleanupTeamName(matchup.left);
    const right = cleanupTeamName(matchup.right);

    if (homeAway === "home") {
      return (
        cleanupTeamName(
          right
            .replace(new RegExp(club, "ig"), "")
            .replace(/SVO/gi, "")
            .replace(/Obrigheim/gi, "")
        ).trim() || right
      );
    } else {
      return (
        cleanupTeamName(
          left
            .replace(new RegExp(club, "ig"), "")
            .replace(/SVO/gi, "")
            .replace(/Obrigheim/gi, "")
        ).trim() || left
      );
    }
  }

  return cleanupTeamName(summary);
}

function formatTime(dt) {
  return dt.setZone(TZ).toFormat("HH:mm");
}
function formatDate(dt) {
  return dt.setZone(TZ).toFormat("dd.LL.yyyy");
}

function formatLine2(dt, location) {
  const time = `${formatTime(dt)} Uhr`;
  const loc = norm(location);
  if (!loc) return time;
  return `${time} - ${loc}`;
}

function makeMatchupLine(feed, homeAway, opponent) {
  const club = feed.clubShort;
  return homeAway === "home" ? `${club} vs. ${opponent}` : `${opponent} vs. ${club}`;
}

function makeTitle(feed, homeAway) {
  const team = feed.teamLabel;
  const placeEmoji = homeAway === "home" ? "🏠" : "✈️";
  if (homeAway === "home") return `${placeEmoji} ${team} Heimspiel 💛💙`;
  return `${placeEmoji} ${team} Auswärtsspiel 💛💙`;
}

function makeBody(feed, homeAway, opponent, dt, location) {
  const line1 = makeMatchupLine(feed, homeAway, opponent);
  const line2 = formatLine2(dt, location);
  return `${line1}\n${line2}`;
}

function makeCollapseId(prefix, teamKey, eventKey) {
  const raw = `${prefix}-${teamKey}-${eventKey}`;
  return raw.length <= 60 ? raw : raw.slice(0, 60);
}

async function sendToTopic(topic, title, body, data = {}, collapseId = null) {
  const msg = {
    topic,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
  };

  if (collapseId) {
    msg.android = { notification: { tag: collapseId } };
    msg.apns = { headers: { "apns-collapse-id": collapseId } };
  }

  await admin.messaging().send(msg);
}

// Catch-up Fenster: statt nur "±WINDOW_MINUTES um fireAt",
// schicken wir, wenn fireAt zwischen lastRun und now liegt (plus kleiner Toleranz).
function shouldFire(fireAt, lastRun, now) {
  const lower = lastRun.minus({ minutes: WINDOW_MINUTES });
  const upper = now.plus({ minutes: WINDOW_MINUTES });
  return fireAt >= lower && fireAt <= upper;
}

// ====== Hauptlauf ======
(async () => {
  const now = DateTime.now().setZone(TZ);
  const lookahead = now.plus({ days: LOOKAHEAD_DAYS });

  // lastRun aus state lesen
  let lastRun = null;
  if (state.meta?.lastRun) {
    const t = DateTime.fromISO(state.meta.lastRun, { zone: TZ });
    if (t.isValid) lastRun = t;
  }
  // wenn noch nie gelaufen: "so tun als wäre lastRun 15 Minuten her"
  if (!lastRun) lastRun = now.minus({ minutes: 15 });

  console.log(`Now: ${now.toISO()} (${TZ}), catch-up from lastRun=${lastRun.toISO()}, window ±${WINDOW_MINUTES}min`);

  // 0) FORCE PUSH (falls gesetzt)
  if (FORCE_PUSH_AT && FORCE_PUSH_TOPIC) {
    const forceAt = DateTime.fromISO(FORCE_PUSH_AT, { zone: TZ });
    if (forceAt.isValid) {
      const within = shouldFire(forceAt, lastRun, now);
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

    let cal;
    try {
      const icsText = await fetchTextWithRetry(feed.ics, 4);
      cal = ical.parseICS(icsText);
    } catch (e) {
      // WICHTIG: nicht den ganzen Run killen (sonst bleiben auch andere Teams/State stehen)
      const code = e?.cause?.code || e?.code || "";
      console.log(`WARN: Failed to load ICS for ${feed.teamKey}. code=${code}. Will try again next run.`);
      continue;
    }

    for (const item of Object.values(cal)) {
      if (!item || item.type !== "VEVENT" || !item.start) continue;

      const start = DateTime.fromJSDate(item.start, { zone: TZ });
      const summary = norm(item.summary || "Spiel");
      const location = norm(item.location || "");
      const uid = norm(item.uid || "");

      if (start < now.minus({ hours: 6 })) continue;
      if (start > lookahead) continue;

      const homeAway = determineHomeAway(feed, summary, location);
      const opponent = extractOpponentName(feed, summary, homeAway);

      // Event-Key
      const baseKey = uid || `${feed.teamKey}|${formatDate(start)}|${summary}`;
      const eventKey = Buffer.from(baseKey).toString("base64url");

      const prev = state.events[eventKey];
      const currentSnapshot = {
        teamKey: feed.teamKey,
        teamLabel: feed.teamLabel,
        clubShort: feed.clubShort,
        kickoff: start.toISO(),
        location,
        summary,
        homeAway,
        opponent,
      };

      // --- Verlegung erkennen ---
      if (prev) {
        const kickoffChanged = prev.kickoff !== currentSnapshot.kickoff;
        const locationChanged = norm(prev.location) !== norm(currentSnapshot.location);
        const homeAwayChanged = prev.homeAway !== currentSnapshot.homeAway;

        if (kickoffChanged || locationChanged || homeAwayChanged) {
          const placeEmoji = currentSnapshot.homeAway === "home" ? "🏠" : "✈️";
          const title = `🔁 ${placeEmoji} Spiel verlegt – ${feed.teamLabel} 💛💙`;

          const line1 = makeMatchupLine(feed, currentSnapshot.homeAway, currentSnapshot.opponent);

          const prevDT = DateTime.fromISO(prev.kickoff, { zone: TZ });
          const currDT = start;

          const prevDate = formatDate(prevDT);
          const currDate = formatDate(currDT);

          const prevWhen = prevDate !== currDate ? `${prevDate} ${formatTime(prevDT)} Uhr` : `${formatTime(prevDT)} Uhr`;
          const currWhen = prevDate !== currDate ? `${currDate} ${formatTime(currDT)} Uhr` : `${formatTime(currDT)} Uhr`;

          const prevLine = `${prevWhen} - ${norm(prev.location) || "-"}`;
          const currLine = `${currWhen} - ${norm(currentSnapshot.location) || "-"}`;

          const body = `${line1}\nAlt: ${prevLine}\nNeu: ${currLine}`;

          const relocationId = `reloc|${feed.teamKey}|${eventKey}|${currentSnapshot.kickoff}|${currentSnapshot.location}|${currentSnapshot.homeAway}`;
          if (!wasSent(relocationId)) {
            console.log(`RELOCATION -> ${feed.teamKey} event=${eventKey}`);

            const collapseId = makeCollapseId("reloc", feed.teamKey, eventKey);

            for (const k of ["d4", "d1", "h1"]) {
              const t = TOPICS[feed.teamKey][k];
              await sendToTopic(
                t,
                title,
                body,
                {
                  kind: "relocation",
                  team: feed.teamKey,
                  eventKey,
                  oldKickoff: prev.kickoff,
                  newKickoff: currentSnapshot.kickoff,
                  oldLocation: prev.location || "",
                  newLocation: currentSnapshot.location || "",
                  homeAway: currentSnapshot.homeAway,
                  opponent: currentSnapshot.opponent,
                },
                collapseId
              );
            }

            markSent(relocationId);
          } else {
            console.log("RELOCATION already sent for this change (deduped).");
          }
        }
      }

      // Snapshot speichern
      state.events[eventKey] = {
        kickoff: currentSnapshot.kickoff,
        location: currentSnapshot.location,
        summary: currentSnapshot.summary,
        homeAway: currentSnapshot.homeAway,
        opponent: currentSnapshot.opponent,
        teamKey: currentSnapshot.teamKey,
      };

      // --- Normale Reminder Pushes (d4/d1/h1) ---
      for (const off of OFFSETS) {
        const fireAt = start.minus(off.minus);

        if (!shouldFire(fireAt, lastRun, now)) continue;

        const id = `${feed.teamKey}|${off.key}|${eventKey}|${currentSnapshot.kickoff}|${currentSnapshot.location}|${currentSnapshot.homeAway}`;
        if (wasSent(id)) continue;

        const topic = TOPICS[feed.teamKey][off.key];

        const title = makeTitle(feed, homeAway);
        const body = makeBody(feed, homeAway, opponent, start, location);

        console.log(`SENDING -> topic=${topic} id=${id} fireAt=${fireAt.toISO()}`);
        await sendToTopic(topic, title, body, {
          kind: "match",
          team: feed.teamKey,
          offset: off.key,
          eventKey,
          kickoff: start.toISO(),
          homeAway,
          opponent,
          location,
          summary,

          // (optional) fürs spätere Deep-Linking in der App
          // du kannst später in der App anhand "team" direkt zur richtigen Seite springen
        });

        markSent(id);
      }
    }
  }

  // lastRun aktualisieren
  state.meta.lastRun = now.toISO();
  saveState();
  console.log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
