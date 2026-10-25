import fs from "fs";
import dns from "dns";
import { DateTime } from "luxon";
import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { FEEDS, H4A_URL } from "./feeds.mjs";   // Teams und Liga-IDs
import { liveAktion, liveLaeuft, liveStand } from "./live.mjs";

const TZ = "Europe/Berlin";
const STATE_PATH = "./state.json";
const ADMIN_QUEUE_PATH = "./admin_queue.json";
const ADMIN_MAX_DELAY_MINUTES = 120; // geplante Admin-Pushes, die mehr als 2h überfällig sind, verfallen

// ====== Scheduler Einstellungen ======
const WINDOW_MINUTES = 6;      // Rückblick über den letzten Lauf hinaus (Catch-up)
const EARLY_MINUTES = 1;       // höchstens so viel zu früh senden (Uhr-Toleranz), sonst lieber bis zum nächsten Lauf warten
const LOOKAHEAD_DAYS = 180;    // wie weit voraus wir Spiele betrachten
const FETCH_TIMEOUT_MS = 15000;

// Ergebnis-Push nach Spielende
// Wird das Ergebnis erst später eingetragen, schicken wir es noch bis so lange nach Anpfiff
const RESULT_MAX_HOURS = 48;

// Live-Spielstand (App ab 1.11, Topic live_<team>, siehe sendLiveStand und live.mjs). Die App blendet
// ihn nach 20 min ohne Nachricht aus. Nachrichten, die länger als LIVE_TTL_SECONDS unterwegs wären, verfallen.
const LIVE_TTL_SECONDS = 10 * 60;
// Läuft ein Spiel, bleibt der Lauf offen und fragt jede LIVE_TAKT_MS nur dessen Liga neu ab, bis
// LIVE_SCHLEIFE_MINUTEN nach Laufbeginn. Der nächste Lauf (cron-job.org alle 5 min) wartet so lange in der
// concurrency-Warteschlange und übernimmt danach. 1 Abfrage pro Minute und laufendem Spiel (GitHub-IP).
const LIVE_TAKT_MS = 60 * 1000;
const LIVE_SCHLEIFE_MINUTEN = 4;

// Topics pro Team + Offset (muss zu push.php auf svohandball.de passen)
const TOPICS = {
  herren: { d4: "team_herren_d4", d1: "team_herren_d1", h1: "team_herren_h1" },
  herren2: { d4: "team_herren2_d4", d1: "team_herren2_d1", h1: "team_herren2_h1" },
  c1:     { d4: "team_c1_d4",     d1: "team_c1_d1",     h1: "team_c1_h1" },
  b1:     { d4: "team_b1_d4",     d1: "team_b1_d1",     h1: "team_b1_h1" },
  d1jugend: { d4: "team_d1jugend_d4", d1: "team_d1jugend_d1", h1: "team_d1jugend_h1" },
  d2jugend: { d4: "team_d2jugend_d4", d1: "team_d2jugend_d1", h1: "team_d2jugend_h1" },
  e1jugend: { d4: "team_e1jugend_d4", d1: "team_e1jugend_d1", h1: "team_e1jugend_h1" },
  e2jugend: { d4: "team_e2jugend_d4", d1: "team_e2jugend_d1", h1: "team_e2jugend_h1" },
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
let state = { sent: {}, events: {}, meta: {}, live: {} };
if (fs.existsSync(STATE_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.sent ||= {};
    state.events ||= {};
    state.meta ||= {};
    state.live ||= {};
  } catch {
    state = { sent: {}, events: {}, meta: {}, live: {} };
  }
} else {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function contentSnapshot() {
  // resultsSince gehört dazu, sonst würde es beim ersten Lauf nicht gespeichert
  return JSON.stringify({ sent: state.sent, events: state.events, live: state.live, resultsSince: state.meta.resultsSince });
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

    // Liveticker: gAppid/gToken sind leer, solange es für das Spiel keinen Ticker gibt
    const token = norm(g.gToken);
    const ticker = token
      ? `https://spo.handball4all.de/service/ticker.html?appid=${encodeURIComponent(norm(g.gAppid))}&token=${encodeURIComponent(token)}`
      : "";

    games.push({
      uid: `h4a|${id}`,
      homeTeam,
      guestTeam,
      ticker,
      start,
      summary: `${homeTeam} - ${guestTeam}`,
      location,
      homeAway: isHome ? "home" : "away",
      opponent: isHome ? guestTeam : homeTeam,
      homeGoals: goals(g.gHomeGoals),
      guestGoals: goals(g.gGuestGoals),
      homeGoalsHalf: goals(g.gHomeGoals_1),
      guestGoalsHalf: goals(g.gGuestGoals_1),
      live: g.live === true,
      comment: norm(g.gComment),
    });
  }

  return games;
}

// Tore: " " oder "-" heißt noch kein Ergebnis
function goals(v) {
  const s = norm(v);
  if (!s || s === "-") return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

// Ergebnis an alle, die mindestens eine Erinnerung des Teams aktiviert haben (einmal pro Gerät)
async function sendResultIfDue(feed, game, eventKey, now, resultsSince) {
  const { start, homeAway, opponent, homeGoals, guestGoals } = game;
  if (homeGoals === null || guestGoals === null) return;
  if (game.live) return; // Liveticker läuft noch, das ist ein Zwischenstand
  if (start < resultsSince) return; // Spiele vor Einführung der Ergebnis-Push nicht nachträglich melden
  if (now < start.plus({ minutes: feed.resultMinMinutes })) return;
  if (now > start.plus({ hours: RESULT_MAX_HOURS })) return;

  const id = `result|${feed.teamKey}|${eventKey}`;
  if (wasSent(id)) return;

  const us = homeAway === "home" ? homeGoals : guestGoals;
  const them = homeAway === "home" ? guestGoals : homeGoals;
  const outcome = us > them ? "✅ Sieg" : us < them ? "❌ Niederlage" : "🤝 Unentschieden";
  const title = `${outcome} – ${feed.teamLabel} 💛💙`;

  const homeName = homeAway === "home" ? feed.clubShort : opponent;
  const guestName = homeAway === "home" ? opponent : feed.clubShort;
  const lines = [`${homeName} ${homeGoals}:${guestGoals} ${guestName}`];
  if (game.homeGoalsHalf !== null && game.guestGoalsHalf !== null) {
    lines.push(`Halbzeit ${game.homeGoalsHalf}:${game.guestGoalsHalf}`);
  }
  if (game.comment) lines.push(game.comment);

  console.log(`RESULT -> ${feed.teamKey} event=${eventKey} ${homeGoals}:${guestGoals}`);
  await sendPush(
    { condition: anyTopicCondition(Object.values(TOPICS[feed.teamKey])) },
    title,
    lines.join("\n"),
    {
      kind: "result",
      team: feed.teamKey,
      eventKey,
      kickoff: start.toISO(),
      homeAway,
      opponent,
      homeGoals,
      guestGoals,
      ...linkData(feed),
    },
    makeCollapseId("result", feed.teamKey, eventKey)
  );
  markSent(id);
}

// "Liveticker läuft": einmal pro Spiel, sobald Handball4all für das Spiel live meldet (höchstens
// 3 h nach Anpfiff, falls ein Ticker nie geschlossen wird). An alle, die mindestens eine Erinnerung
// des Teams haben; die Push öffnet die Team-Seite mit dem Knopf "Zum Liveticker".
async function sendLiveIfDue(feed, game, eventKey, now) {
  if (!game.live || game.spieltag) return;
  if (now < game.start.minus({ minutes: 30 }) || now > game.start.plus({ hours: 3 })) return;
  const id = `live|${feed.teamKey}|${eventKey}`;
  if (wasSent(id)) return;

  console.log(`LIVE -> ${feed.teamKey} event=${eventKey}`);
  await sendPush(
    { condition: anyTopicCondition(Object.values(TOPICS[feed.teamKey])) },
    `🔴 ${feed.teamLabel} – Liveticker läuft 💛💙`,
    `${makeMatchupLine(feed, game.homeAway, game.opponent)}\nJetzt live verfolgen`,
    { kind: "live", team: feed.teamKey, eventKey, ...linkData(feed) },
    makeCollapseId("live", feed.teamKey, eventKey)
  );
  markSent(id);
}

// Live-Spielstand für die App: stille Datennachricht (ohne notification) an live_<team>, angezeigt von
// LiveSpielstand.java als laufende Benachrichtigung bzw. Live Update ab Android 16. Das Topic
// abonniert nur, wer auf /de/app/ den Schalter "Live-Spielstand" einschaltet; Web-Push (iPhone) und
// ältere App-Versionen bekommen nichts davon mit. Solange H4A live meldet, jeder Lauf mit neuem Stand
// (sonst alle LIVE_ERNEUERN_MINUTES), danach einmal "live_ende" mit dem letzten Stand.
async function sendLiveStand(feed, game, eventKey, now) {
  const art = liveAktion(state.live[eventKey], game, now);
  if (!art) return;
  const stand = liveStand(game);

  console.log(`LIVESTAND -> ${feed.teamKey} event=${eventKey} ${stand} (${art})`);
  await sendData(`live_${feed.teamKey}`, {
    kind: art,
    team: feed.teamKey,
    teamLabel: feed.teamLabel,
    eventKey,
    heim: game.homeTeam,
    gast: game.guestTeam,
    heimTore: game.homeGoals ?? 0,
    gastTore: game.guestGoals ?? 0,
    ticker: game.ticker,
    ...linkData(feed),
  });
  state.live[eventKey] = { stand, at: now.toISO(), ...(art === "live_ende" ? { ende: true } : {}) };
}

async function liveSchleife(liveFeeds, laufStart) {
  if (DRY_RUN || VALIDATE_ONLY) return;
  const bis = laufStart.plus({ minutes: LIVE_SCHLEIFE_MINUTEN });
  while (liveFeeds.size && DateTime.now().plus({ milliseconds: LIVE_TAKT_MS }) <= bis) {
    await sleep(LIVE_TAKT_MS);
    for (const feed of [...liveFeeds]) {
      let games;
      try {
        games = await loadGames(feed);
      } catch (e) {
        console.log(`WARN: Live-Schleife ${feed.teamKey}: ${e?.message || e}`);
        continue;
      }
      const jetzt = DateTime.now().setZone(TZ);
      let laeuft = false;
      for (const game of games) {
        const eventKey = Buffer.from(game.uid).toString("base64url");
        await sendLiveStand(feed, game, eventKey, jetzt);
        laeuft ||= liveLaeuft(game, jetzt);
      }
      // Spiel vorbei: live_ende ist gerade verschickt, keine weiteren Abfragen für dieses Team
      if (!laeuft) liveFeeds.delete(feed);
    }
  }
}

// Alte Live-Einträge nach zwei Tagen wegräumen
function liveAufraeumen(now) {
  for (const [key, v] of Object.entries(state.live)) {
    const at = DateTime.fromISO(v.at, { zone: TZ });
    if (!at.isValid || at < now.minus({ days: 2 })) delete state.live[key];
  }
}

// ====== Spieltage (E-Jugend, feed.spieltag) ======
// Unsere Spiele eines Tages, nach Anpfiff sortiert: [{ datum: "2026-10-24", spiele: [...] }]
function spieltage(games) {
  const tage = new Map();
  for (const g of [...games].sort((a, b) => a.start - b.start)) {
    const datum = g.start.toISODate();
    if (!tage.has(datum)) tage.set(datum, []);
    tage.get(datum).push(g);
  }
  return [...tage].map(([datum, spiele]) => ({ datum, spiele }));
}

// "TSV Weinsberg (KO)"
function gegnerMitArt(g) {
  return g.comment ? `${g.opponent} (${g.comment})` : g.opponent;
}

// Ein Spieltag als ein Ereignis für Erinnerungen und Verlegungen: Anpfiff und Halle des ersten Spiels
function spieltagEreignisse(feed, games) {
  return spieltage(games).map(({ datum, spiele }) => {
    const erstes = spiele[0];
    return {
      uid: `h4a-tag|${feed.teamKey}|${datum}`,
      start: erstes.start,
      location: erstes.location,
      summary: `Spieltag ${datum}: ${spiele.map((g) => g.summary).join(" / ")}`,
      homeAway: "tag",
      opponent: spiele.map(gegnerMitArt).join(", "),
      anzahl: spiele.length,
      homeGoals: null,
      guestGoals: null,
      spieltag: true,
    };
  });
}

function spieltagTitel(feed) {
  return `🤾 ${feed.teamLabel} – Spieltag 💛💙`;
}

function spieltagText(ereignis) {
  const dt = ereignis.start.setZone(TZ);
  const lines = [`${dt.setLocale("de").toFormat("ccc")}, ${formatDate(dt)} ab ${formatTime(dt)} Uhr`];
  const loc = norm(ereignis.location);
  if (loc) lines.push(loc);
  lines.push(`${ereignis.anzahl} ${ereignis.anzahl === 1 ? "Spiel" : "Spiele"}: ${ereignis.opponent}`);
  return lines.join("\n");
}

// Ergebnis-Zusammenfassung eines Spieltags: sobald alle Spiele ein Ergebnis haben (frühestens
// resultMinMinutes nach dem letzten Anpfiff), sonst nach Mitternacht mit den vorhandenen
// (KO-Spiele bekommen oft keins). Spätestens RESULT_MAX_HOURS nach dem letzten Spiel.
async function sendSpieltagErgebnisse(feed, games, now, resultsSince) {
  for (const { datum, spiele } of spieltage(games)) {
    const erstes = spiele[0].start, letztes = spiele[spiele.length - 1].start;
    if (erstes < resultsSince) continue;
    if (now > letztes.plus({ hours: RESULT_MAX_HOURS })) continue;
    if (spiele.some((g) => g.live)) continue;
    const mit = spiele.filter((g) => g.homeGoals !== null && g.guestGoals !== null);
    if (!mit.length) continue;
    const alle = mit.length === spiele.length && now >= letztes.plus({ minutes: feed.resultMinMinutes });
    const tagVorbei = now >= erstes.startOf("day").plus({ days: 1 });
    if (!alle && !tagVorbei) continue;

    const id = `result-tag|${feed.teamKey}|${datum}`;
    if (wasSent(id)) continue;

    let s = 0, u = 0, n = 0;
    const zeilen = mit.map((g) => {
      const us = g.homeAway === "home" ? g.homeGoals : g.guestGoals;
      const them = g.homeAway === "home" ? g.guestGoals : g.homeGoals;
      if (us > them) s++; else if (us < them) n++; else u++;
      const heim = g.homeAway === "home" ? feed.clubShort : g.opponent;
      const gast = g.homeAway === "home" ? g.opponent : feed.clubShort;
      return `${heim} – ${gast} ${g.homeGoals}:${g.guestGoals}${g.comment ? ` (${g.comment})` : ""}`;
    });
    const bilanz = [s && `${s} ${s === 1 ? "Sieg" : "Siege"}`, u && `${u} Unentschieden`,
      n && `${n} ${n === 1 ? "Niederlage" : "Niederlagen"}`].filter(Boolean).join(", ");
    const title = `🏁 ${feed.teamLabel} – Spieltag ${erstes.setZone(TZ).toFormat("dd.LL.")} 💛💙`;

    console.log(`RESULT-TAG -> ${feed.teamKey} ${datum} (${mit.length}/${spiele.length} Ergebnisse)`);
    await sendPush(
      { condition: anyTopicCondition(Object.values(TOPICS[feed.teamKey])) },
      title,
      [bilanz, ...zeilen].join("\n"),
      { kind: "result_spieltag", team: feed.teamKey, datum, ...linkData(feed) },
      makeCollapseId("result-tag", feed.teamKey, datum)
    );
    markSent(id);
  }
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

// "So, 04.10.2026 · 18:00 Uhr"
function formatWhen(dt) {
  const day = dt.setZone(TZ).setLocale("de").toFormat("ccc");
  return `${day}, ${formatDate(dt)} · ${formatTime(dt)} Uhr`;
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
  const lines = [makeMatchupLine(feed, homeAway, opponent), formatWhen(dt)];
  const loc = norm(location);
  if (loc) lines.push(loc);
  return lines.join("\n");
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

// Reine Datennachricht (keine Anzeige durch das System), hohe Priorität, verfällt nach LIVE_TTL_SECONDS
async function sendData(topic, data) {
  const msg = {
    topic,
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    android: { priority: "high", ttl: LIVE_TTL_SECONDS * 1000 },
  };
  if (DRY_RUN) {
    console.log(`[DRY_RUN] ${JSON.stringify(msg)}`);
    return;
  }
  await getMessaging().send(msg, VALIDATE_ONLY);
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

  // Ab wann Ergebnisse gemeldet werden: beim ersten Lauf mit dieser Funktion "jetzt", damit nicht
  // plötzlich die Ergebnisse der letzten Tage verschickt werden. RESULTS_SINCE nur zum Testen.
  if (!state.meta.resultsSince) state.meta.resultsSince = now.toISO();
  const resultsSince = DateTime.fromISO(process.env.RESULTS_SINCE || state.meta.resultsSince, { zone: TZ });

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
  const liveFeeds = new Set(); // Teams mit laufendem Spiel, für die Live-Schleife (2)
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

    // E-Jugend: Ergebnisse als Zusammenfassung pro Spieltag, Erinnerungen pro Spieltag
    if (feed.spieltag) {
      await sendSpieltagErgebnisse(feed, games, now, resultsSince);
      games = spieltagEreignisse(feed, games);
    }

    for (const game of games) {
      const { start, summary, location, uid, homeAway, opponent } = game;

      // Event-Key
      const eventKey = Buffer.from(uid).toString("base64url");

      // Ergebnis kommt oft erst Stunden nach dem Spiel, deshalb vor dem 6-Stunden-Filter
      await sendResultIfDue(feed, game, eventKey, now, resultsSince);
      await sendLiveIfDue(feed, game, eventKey, now);
      await sendLiveStand(feed, game, eventKey, now);
      if (liveLaeuft(game, now)) liveFeeds.add(feed);

      if (start < now.minus({ hours: 6 })) continue;
      if (start > lookahead) continue;

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
          const placeEmoji = currentSnapshot.homeAway === "home" ? "🏠" : currentSnapshot.homeAway === "tag" ? "🤾" : "✈️";
          const title = game.spieltag
            ? `🔁 ${placeEmoji} Spieltag verlegt – ${feed.teamLabel} 💛💙`
            : `🔁 ${placeEmoji} Spiel verlegt – ${feed.teamLabel} 💛💙`;

          const line1 = game.spieltag
            ? `Spiele: ${currentSnapshot.opponent}`
            : makeMatchupLine(feed, currentSnapshot.homeAway, currentSnapshot.opponent);

          const prevDT = DateTime.fromISO(prev.kickoff, { zone: TZ });
          const currDT = start;

          const prevLine = `${formatWhen(prevDT)} - ${norm(prev.location) || "-"}`;
          const currLine = `${formatWhen(currDT)} - ${norm(currentSnapshot.location) || "-"}`;

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

        const title = game.spieltag ? spieltagTitel(feed) : makeTitle(feed, homeAway);
        const body = game.spieltag ? spieltagText(game) : makeBody(feed, homeAway, opponent, start, location);

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

  // 2) LIVE-SCHLEIFE: Spielstand jede Minute statt nur alle 5 Minuten
  await liveSchleife(liveFeeds, now);

  liveAufraeumen(now);

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
