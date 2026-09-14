import fs from "fs";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { DateTime } from "luxon";

const TZ = "Europe/Berlin";
const QUEUE_PATH = "./admin_queue.json";
const KEEP_DAYS = 7; // bereits fällige Einträge nach 7 Tagen aus der Queue entfernen
const MAX_LATE_MINUTES = 120; // wie ADMIN_MAX_DELAY_MINUTES in index.mjs

const TITLE = (process.env.TITLE || "").trim();
const BODY = (process.env.BODY || "").trim();
const SEND_AT = (process.env.SEND_AT || "").trim(); // "YYYY-MM-DDTHH:MM" oder "DD.MM.YYYY HH:MM" (Berlin) oder leer

if (!TITLE || !BODY) {
  console.error("Missing TITLE/BODY");
  process.exit(1);
}

// admin_queue.json wird nur hier geschrieben. Der Scheduler (index.mjs) liest sie nur und merkt
// sich Verschicktes in state.json – so kommen sich die beiden Workflows in Git nicht in die Quere.
function loadQueue() {
  if (!fs.existsSync(QUEUE_PATH)) {
    return { items: [] };
  }
  const q = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  q.items ||= [];
  return q;
}
function saveQueue(q) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2));
}

function parseSendAt(s) {
  const formats = ["yyyy-LL-dd'T'HH:mm", "yyyy-LL-dd HH:mm", "dd.LL.yyyy HH:mm", "d.L.yyyy HH:mm"];
  for (const f of formats) {
    const dt = DateTime.fromFormat(s, f, { zone: TZ });
    if (dt.isValid) return dt;
  }
  // z.B. mit Sekunden oder Zeitzone: "2026-09-20T17:00:00", "2026-09-20T17:00+02:00"
  const iso = DateTime.fromISO(s, { zone: TZ });
  return iso.isValid ? iso : null;
}

async function sendNow() {
  if (!process.env.FIREBASE_SA_B64) {
    console.error("Missing FIREBASE_SA_B64");
    process.exit(1);
  }
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
  );

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  // Send to "all" topic
  await getMessaging().send({
    topic: "all",
    notification: { title: TITLE, body: BODY },
    data: { kind: "admin", sentAt: DateTime.now().setZone(TZ).toISO() },
    android: { notification: { tag: "admin-broadcast" } },
    apns: { headers: { "apns-collapse-id": "admin-broadcast" } }
  });

  console.log("✅ Admin push sent to topic=all");
}

(async () => {
  if (!SEND_AT) {
    await sendNow();
    return;
  }

  // schedule mode: write into queue (scheduler will deliver)
  const dt = parseSendAt(SEND_AT);
  if (!dt) {
    console.error(`Ungültiger Zeitpunkt "${SEND_AT}". Erlaubt: 2026-09-20T17:00 oder 20.09.2026 17:00 (deutsche Zeit)`);
    process.exit(1);
  }

  // Schon vorbei (z.B. im Formular auf admin-push.php "in 1 Minute" gewählt und etwas gebraucht):
  // bis 2h sofort senden, älter ist sicher ein Tippfehler. Ein Fehler hier wäre auf admin-push.php
  // unsichtbar – die Seite meldet Erfolg, sobald GitHub den Workflow angenommen hat.
  const now = DateTime.now().setZone(TZ);
  const lateMinutes = now.diff(dt, "minutes").minutes;
  if (lateMinutes > MAX_LATE_MINUTES) {
    console.error(`Zeitpunkt ${dt.toFormat("dd.LL.yyyy HH:mm")} liegt mehr als 2 Stunden in der Vergangenheit. Für sofort das Feld leer lassen.`);
    process.exit(1);
  }
  if (lateMinutes > 0) {
    console.log(`Zeitpunkt ${dt.toFormat("dd.LL.yyyy HH:mm")} ist schon vorbei – wird sofort gesendet.`);
    await sendNow();
    return;
  }

  const q = loadQueue();

  // Alte, längst fällige Einträge aufräumen
  const cutoff = now.minus({ days: KEEP_DAYS });
  q.items = q.items.filter((it) => {
    const t = DateTime.fromISO(it.sendAt || "", { zone: TZ });
    return !t.isValid || t > cutoff;
  });

  const id = `admin|${dt.toISO()}|${TITLE}|${BODY}`;
  if (q.items.some((it) => it.id === id)) {
    console.log("Dieser Push ist bereits eingeplant:", dt.toISO());
    return;
  }

  q.items.push({
    id,
    sendAt: dt.toISO(),
    title: TITLE,
    body: BODY,
    topic: "all",
    createdAt: now.toISO()
  });

  saveQueue(q);
  console.log(`✅ Admin push queued for ${dt.toFormat("dd.LL.yyyy HH:mm")} (${dt.toISO()})`);
})();
