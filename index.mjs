import fs from "fs";
import dns from "dns";
import { DateTime } from "luxon";
import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

const TZ = "Europe/Berlin";
const STATE_PATH = "./state.json";
const ADMIN_QUEUE_PATH = "./admin_queue.json";
const ADMIN_MAX_DELAY_MINUTES = 120; // geplante Admin-Pushes, die mehr als 2h überfällig sind, verfallen

// ====== Scheduler Einstellungen ======
const WINDOW_MINUTES = 6;      // Rückblick über den letzten Lauf hinaus (Catch-up)
const EARLY_MINUTES = 1;       // höchstens so viel zu früh senden (Uhr-Toleranz), sonst lieber bis zum nächsten Lauf warten
const LOOKAHEAD_DAYS = 180;    // wie weit voraus wir Spiele betrachten
const FETCH_TIMEOUT_MS = 15000;

// Teams / Handball4all-Ligen
// Die handball.net-ICS-Feeds gibt es nicht mehr (404). Wir holen den Spielplan der Liga direkt
// von Handball4all – dieselbe Quelle wie h4a-proxy.php auf svohandball.de.
// ⚠️ Die Liga-ID (classId) ändert sich jede Saison und muss dann hier aktualisiert werden.
//    classId steht in der Spielplan-URL auf handball4all.de (Parameter "cl").
// teamMatch: Teil des Mannschaftsnamens, wie er in gHomeTeam/gGuestTeam steht.
const H4A_URL = "https://spo.handball4all.de/service/if_g_json.php";

const FEEDS = [
  {
    teamKey: "herren",
    teamLabel: "Herren 1",
    clubShort: "SVO",
    org: 216,          // Baden-Württembergischer Handball-Verband
    classId: 161161,   // Männer-Landesliga Staffel 1, Saison 26/27
    teamMatch: "SV Obrigheim",
    deeplink: "https://svohandball.de/de/mannschaften/1-mannschaft/",
  },
  {
    teamKey: "herren2",
    teamLabel: "Herren 2",
    clubShort: "SVO 2",
    org: 216,
    classId: 161571,   // Männer 2. Bezirksklasse Gruppe 1, Saison 26/27
    teamMatch: "SV Obrigheim 2",
    deeplink: "https://svohandball.de/de/mannschaften/1-mannschaft/",
  },
  {
    teamKey: "c1",     // Key bleibt "c1", damit bestehende Abos (team_c1_*) weiter funktionieren
    teamLabel: "C-Jugend",
    clubShort: "JSG",
    org: 216,
    classId: 165801,   // mC-Jugend Bezirksklasse Gruppe 1, Saison 26/27
    teamMatch: "Neck-Obrig",   // "JSG Neck-Obrig"
    deeplink: "https://svohandball.de/de/mannschaften/c-jugend/",
  },
  {
    teamKey: "b1",
    teamLabel: "B-Jugend",
    clubShort: "JSG",
    org: 216,
    classId: 165711,   // mB-Jugend Bezirksliga Gruppe 1, Saison 26/27
    teamMatch: "Neck-Obrig",
    deeplink: "https://svohandball.de/de/mannschaften/B-Jugend/",
  },
];

// Topics pro Team + Offset (muss zu push.php auf svohandball.de passen)
const TOPICS = {
  herren: { d4: "team_herren_d4", d1: "team_herren_d1", h1: "team_herren_h1" },
  herren2: { d4: "team_herren2_d4", d1: "team_herren2_d1", h1: "team_herren2_h1" },
  c1:     { d4: "team_c1_d4",     d1: "team_c1_d1",     h1: "team_c1_h1" },
  b1:     { d4: "team_b1_d4",     d1: "team_b1_d1",     h1: "team_b1_h1" },
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

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTextWithRetry(url, attempts = 4) {
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    let status = null;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "User-Agent": "svo-push-scheduler/1.0 (+github-actions)",
          "Accept": "application/json,*/*",
        },
      });
      status = res.status;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;

      const code = e?.cause?.code || e?.name || "";

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

// ====== Dry-Run (lokal testen: DRY_RUN=1 node index.mjs) ======
// Sendet nichts, schreibt state.json nicht und braucht keinen Firebase-Key.
const DRY_RUN = process.env.DRY_RUN === "1";

// ====== Prüfmodus (GitHub: Workflow "Push Scheduler" von Hand mit "validate_only" starten) ======
// Wie ein echter Lauf mit Firebase-Key, aber Firebase prüft die Nachrichten nur und stellt nichts zu.
// state.json wird nicht geschrieben, damit nichts fälschlich als verschickt gilt.
const VALIDATE_ONLY = process.env.FCM_VALIDATE_ONLY === "true" || process.env.FCM_VALIDATE_ONLY === "1";

// ====== Firebase Admin init ======
if (!DRY_RUN) {
  if (!process.env.FIREBASE_SA_B64) {
    console.error("Missing env FIREBASE_SA_B64");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
  );

  initializeApp({
    credential: cert(serviceAccount),
  });
}

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

function contentSnapshot() {
  return JSON.stringify({ sent: state.sent, events: state.events });
}
const initialSnapshot = contentSnapshot();

function wasSent(id) {
  return !!state.sent[id];
}
function markSent(id) {
  state.sent[id] = true;
}
function saveState() {
  if (DRY_RUN || VALIDATE_ONLY) return;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function norm(s) {
  return (s || "").toString().replace(/\s+/g, " ").trim();
}
function containsIgnoreCase(haystack, needle) {
  return (haystack || "").toLowerCase().includes((needle || "").toLowerCase());
}

// Spielplan einer Liga von Handball4all laden und auf unsere Spiele filtern.
// Liefert [{ uid, start, summary, location, homeAway, opponent }]
async function loadGames(feed) {
  const url = `${H4A_URL}?cmd=ps&og=${feed.org}&cl=${feed.classId}&ca=1`;
  const text = await fetchTextWithRetry(url, 4);

  const data = typeof text === "string" ? JSON.parse(text) : text;
  const content = Array.isArray(data) ? data[0]?.content : null;
  if (!content) {
    // z.B. {"status":-1,"statusText":"permission denied"}
    throw new Error(`Unexpected H4A response: ${String(text).slice(0, 120)}`);
  }

  const all = [...(content.actualGames?.games || []), ...(content.futureGames?.games || [])];

  const seen = new Set();
  const games = [];

  for (const g of all) {
    const homeTeam = norm(g.gHomeTeam);
    const guestTeam = norm(g.gGuestTeam);
    const isHome = containsIgnoreCase(homeTeam, feed.teamMatch);
    const isGuest = containsIgnoreCase(guestTeam, feed.teamMatch);
    if (!isHome && !isGuest) continue;

    const id = norm(g.gID) || norm(g.gNo);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // gDate "20.09.26", gTime "18:00" (Ortszeit). Spiele ohne feste Anwurfzeit überspringen.
    const start = DateTime.fromFormat(`${norm(g.gDate)} ${norm(g.gTime)}`, "dd.LL.yy HH:mm", { zone: TZ });
    if (!start.isValid) continue;

    // Gleiches Format wie früher im ICS: "Neckarhalle, Am Park 8, D-74847 Obrigheim"
    const town = [norm(g.gGymnasiumPostal) && `D-${norm(g.gGymnasiumPostal)}`, norm(g.gGymnasiumTown)]
      .filter(Boolean)
      .join(" ");
    const location = [norm(g.gGymnasiumName), norm(g.gGymnasiumStreet), town].filter(Boolean).join(", ");

    games.push({
      uid: `h4a|${id}`,
      start,
      summary: `${homeTeam} - ${guestTeam}`,
      location,
      homeAway: isHome ? "home" : "away",
      opponent: isHome ? guestTeam : homeTeam,
    });
  }

  return games;
}

// "deeplink" öffnet die App (ab Version 1.1) nativ. Bewusst kein "url"-Feld mehr: das hat der alte
// pushNotificationActionPerformed-Listener auf der Startseite gelesen und konnte so später
// nochmal zur Seite einer alten Push springen.
function linkData(feed) {
  return { deeplink: feed.deeplink };
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

// target: { topic: "..." } oder { condition: "'a' in topics || 'b' in topics" }
async function sendPush(target, title, body, data = {}, collapseId = null) {
  const msg = {
    ...target,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
  };

  if (collapseId) {
    msg.android = { notification: { tag: collapseId } };
    msg.apns = { headers: { "apns-collapse-id": collapseId } };
  }

  if (DRY_RUN) {
    console.log(`[DRY_RUN] ${JSON.stringify(msg)}`);
    return;
  }

  await getMessaging().send(msg, VALIDATE_ONLY);
  if (VALIDATE_ONLY) console.log(`[VALIDATE_ONLY] von Firebase akzeptiert, nicht zugestellt: ${JSON.stringify(target)} "${title}"`);
}

async function sendToTopic(topic, title, body, data = {}, collapseId = null) {
  await sendPush({ topic }, title, body, data, collapseId);
}

// Eine Nachricht an alle, die mindestens eines der Topics abonniert haben – jedes Gerät bekommt sie
// nur einmal (FCM erlaubt bis zu 5 Topics pro Bedingung).
function anyTopicCondition(topics) {
  return topics.map((t) => `'${t}' in topics`).join(" || ");
}

// Catch-up Fenster: schicken, wenn fireAt zwischen lastRun und now liegt.
// Nach vorne nur EARLY_MINUTES Toleranz: früher waren es 6 Minuten, dadurch kam z.B. die
// 18:00-Erinnerung schon beim Lauf um 17:55. Der Scheduler läuft alle 5 Minuten (cron-job.org),
// eine Push kommt jetzt also zwischen fireAt und ca. fireAt + 5 Minuten.
function shouldFire(fireAt, lastRun, now) {
  const lower = lastRun.minus({ minutes: WINDOW_MINUTES });
  const upper = now.plus({ minutes: EARLY_MINUTES });
  return fireAt >= lower && fireAt <= upper;
}

// ====== Geplante Admin-Pushes ======
// admin_queue.json wird nur vom Workflow "Admin Push" geschrieben (scripts/admin_push_dispatch.mjs)
// und hier nur gelesen. Was verschickt wurde, steht in state.sent. So schreiben die beiden
// Workflows nie in dieselbe Datei und es gibt keine Git-Konflikte.
function loadAdminQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(ADMIN_QUEUE_PATH, "utf8"));
    return Array.isArray(q.items) ? q.items : [];
  } catch {
    return [];
  }
}

async function processAdminQueue(now) {
  for (const it of loadAdminQueue()) {
    const sendAt = DateTime.fromISO(norm(it.sendAt), { zone: TZ });
    const topic = norm(it.topic) || "all";
    const title = norm(it.title);
    const body = String(it.body || "").trim(); // Zeilenumbrüche behalten (wie beim Sofort-Senden)
    if (!sendAt.isValid || !title || !body) continue;

    const id = it.id || `admin|${sendAt.toISO()}|${title}|${body}`;
    if (wasSent(id)) continue;

    // Noch nicht dran (höchstens 1 Minute zu früh senden)
    if (sendAt > now.plus({ minutes: 1 })) continue;

    const delayMinutes = now.diff(sendAt, "minutes").minutes;
    if (delayMinutes > ADMIN_MAX_DELAY_MINUTES) {
      console.log(`ADMIN QUEUE: ${Math.round(delayMinutes)} min überfällig, verfällt: ${id}`);
      state.sent[id] = "expired";
      continue;
    }

    console.log(`ADMIN QUEUE: SENDING -> topic=${topic} sendAt=${sendAt.toISO()}`);
    await sendToTopic(topic, title, body, { kind: "admin", scheduledAt: sendAt.toISO() }, "admin-broadcast");
    markSent(id);
  }
}

// ====== Hauptlauf ======
(async () => {
  const now = DateTime.now().setZone(TZ);
  const lookahead = now.plus({ days: LOOKAHEAD_DAYS });

  if (VALIDATE_ONLY) {
    // Prüft Firebase-Zugang und Nachrichtenformat einmal, auch wenn gerade nichts fällig ist
    console.log("PRÜFMODUS: Firebase prüft Nachrichten nur, es wird nichts zugestellt und nichts gespeichert.");
    await sendPush({ topic: "all" }, "Prüfung", "Prüfnachricht (wird nicht zugestellt)", { kind: "validate" });
    await sendPush({ condition: anyTopicCondition(Object.values(TOPICS.herren)) }, "Prüfung", "Prüfnachricht (Bedingung)", { kind: "validate" });
  }

  // lastRun aus state lesen
  let lastRun = null;
  if (state.meta?.lastRun) {
    const t = DateTime.fromISO(state.meta.lastRun, { zone: TZ });
    if (t.isValid) lastRun = t;
  }
  // wenn noch nie gelaufen: "so tun als wäre lastRun 15 Minuten her"
  if (!lastRun) lastRun = now.minus({ minutes: 15 });

  console.log(`Now: ${now.toISO()} (${TZ}), catch-up from lastRun=${lastRun.toISO()}, window -${WINDOW_MINUTES}/+${EARLY_MINUTES}min`);

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

  // 0b) GEPLANTE ADMIN-PUSHES
  await processAdminQueue(now);

  // 1) NORMALER SCHEDULER (Handball4all)
  for (const feed of FEEDS) {
    if (!feed.classId) {
      console.log(`WARN: No classId configured for ${feed.teamKey}, skipping.`);
      continue;
    }

    console.log(`Loading H4A games for ${feed.teamKey} (class ${feed.classId})...`);

    let games;
    try {
      games = await loadGames(feed);
    } catch (e) {
      // WICHTIG: nicht den ganzen Run killen (sonst bleiben auch andere Teams/State stehen)
      const code = e?.cause?.code || e?.code || e?.message || "";
      console.log(`WARN: Failed to load games for ${feed.teamKey}. code=${code}. Will try again next run.`);
      continue;
    }

    console.log(`  ${games.length} games found for ${feed.teamKey}`);

    for (const game of games) {
      const { start, summary, location, uid, homeAway, opponent } = game;

      if (start < now.minus({ hours: 6 })) continue;
      if (start > lookahead) continue;

      // Event-Key
      const eventKey = Buffer.from(uid).toString("base64url");

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

            // Einmal an alle, die das Team in irgendeiner Form abonniert haben (4 Tage/1 Tag/1 Stunde).
            // Früher ging je eine Nachricht an jedes Topic -> wer alle drei hatte, bekam sie dreifach.
            await sendPush(
              { condition: anyTopicCondition(Object.values(TOPICS[feed.teamKey])) },
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
                ...linkData(feed),
              },
              collapseId
            );

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
      // GitHub startet den Cron oft stundenlang verspätet – eine Erinnerung nach Anpfiff ist sinnlos.
      if (start <= now) continue;

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
          ...linkData(feed),
        });

        markSent(id);
      }
    }
  }

  // lastRun aktualisieren – aber nur speichern (= committen), wenn sich wirklich etwas geändert hat.
  // Sonst gäbe es beim 5-Minuten-Takt fast 300 Commits pro Tag. Ein älteres lastRun ist unkritisch:
  // das Catch-up-Fenster wird nur größer, doppelte Pushes verhindert state.sent.
  const changed = contentSnapshot() !== initialSnapshot;
  const lastRunAgeHours = now.diff(lastRun, "hours").hours;
  if (changed || lastRunAgeHours >= 6) {
    state.meta.lastRun = now.toISO();
    saveState();
  } else {
    console.log("No state changes, not saving.");
  }
  console.log("done");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
