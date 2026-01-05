import fs from "fs";
import ical from "node-ical";
import { DateTime } from "luxon";
import admin from "firebase-admin";

const TZ = "Europe/Berlin";

const FEEDS = [
  { teamKey: "herren", ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1325866.ics" },
  { teamKey: "c1",     ics: "https://handball.net/a/sportdata/1/calendar/team/handball4all.baden-wuerttemberg.1345071.ics" }
];

// Topics pro Offset
const TOPICS = {
  herren: { d4: "team_herren_d4", d1: "team_herren_d1", h1: "team_herren_h1" },
  c1:     { d4: "team_c1_d4",     d1: "team_c1_d1",     h1: "team_c1_h1" }
};

const OFFSETS = [
  { key: "d4", minus: { days: 4 }, label: "In 4 Tagen" },
  { key: "d1", minus: { days: 1 }, label: "Morgen" },
  { key: "h1", minus: { hours: 1 }, label: "In 1 Stunde" }
];

const statePath = "./state.json";
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.sent ||= {};

const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const now = DateTime.now().setZone(TZ);
const WINDOW_MINUTES = 4;

function wasSent(id){ return !!state.sent[id]; }
function markSent(id){ state.sent[id] = true; }

function norm(s){ return (s||"").replace(/\s+/g," ").trim(); }

async function sendToTopic(topic, title, body, data = {}) {
  await admin.messaging().send({ topic, notification: { title, body }, data });
}

for (const feed of FEEDS) {
  const events = await ical.async.fromURL(feed.ics);

  for (const ev of Object.values(events)) {
    if (!ev || ev.type !== "VEVENT" || !ev.start) continue;

    const start = DateTime.fromJSDate(ev.start, { zone: TZ });
    if (start < now.minus({ hours: 2 })) continue;

    const summary = norm(ev.summary || "Spiel");
    const location = norm(ev.location || "");

    for (const off of OFFSETS) {
      const fireAt = start.minus(off.minus);
      const diffMin = fireAt.diff(now, "minutes").minutes;
      if (diffMin < -WINDOW_MINUTES || diffMin > WINDOW_MINUTES) continue;

      const id = `${feed.teamKey}_${off.key}_${start.toISO()}_${summary}`;
      if (wasSent(id)) continue;

      const topic = TOPICS[feed.teamKey][off.key];
      const title = `${off.label}: ${feed.teamKey === 'herren' ? 'Herren' : 'C1'}`;
      const body = location ? `${summary} • ${start.toFormat("dd.LL.yyyy HH:mm")} • ${location}`
                            : `${summary} • ${start.toFormat("dd.LL.yyyy HH:mm")}`;

      await sendToTopic(topic, title, body, {
        team: feed.teamKey,
        kickoff: start.toISO(),
        offset: off.key
      });

      markSent(id);
      console.log("SENT", id);
    }
  }
}

fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log("done");
