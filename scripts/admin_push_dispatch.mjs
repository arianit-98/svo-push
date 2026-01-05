import fs from "fs";
import admin from "firebase-admin";
import { DateTime } from "luxon";

const TZ = "Europe/Berlin";
const QUEUE_PATH = "./admin_queue.json";

const TITLE = (process.env.TITLE || "").trim();
const BODY = (process.env.BODY || "").trim();
const SEND_AT = (process.env.SEND_AT || "").trim(); // "YYYY-MM-DDTHH:MM" (Berlin) oder leer

if (!TITLE || !BODY) {
  console.error("Missing TITLE/BODY");
  process.exit(1);
}

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

async function sendNow() {
  if (!process.env.FIREBASE_SA_B64) {
    console.error("Missing FIREBASE_SA_B64");
    process.exit(1);
  }
  const serviceAccount = JSON.parse(
    Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
  );

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }

  // Send to "all" topic
  await admin.messaging().send({
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
  const dt = DateTime.fromFormat(SEND_AT, "yyyy-LL-dd'T'HH:mm", { zone: TZ });
  if (!dt.isValid) {
    console.error("Invalid SEND_AT. Expected YYYY-MM-DDTHH:MM (Berlin)");
    process.exit(1);
  }

  const q = loadQueue();
  const id = `admin|${dt.toISO()}|${TITLE}|${BODY}`;
  q.items.push({
    id,
    sendAt: dt.toISO(),
    title: TITLE,
    body: BODY,
    topic: "all",
    createdAt: DateTime.now().setZone(TZ).toISO()
  });

  saveQueue(q);
  console.log("✅ Admin push queued for:", dt.toISO());
})();
