// Test-Push an ein Test-Topic (Workflow "Test Push" oder lokal mit FIREBASE_SA_B64).
// Nur Topics, die mit "svo_test" beginnen – so landet ein Test nie versehentlich bei allen Nutzern.
// Ein Gerät meldet sich dafür z.B. per Capacitor.Plugins.Topic.subscribe({ topic: "svo_test" }) an.
import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

const topic = (process.env.TOPIC || "svo_test").trim();
const title = (process.env.TITLE || "SVO Push Test ✅").trim();
const body = (process.env.BODY || "Wenn du das siehst, funktioniert GitHub → Firebase → Handy.").trim();
const deeplink = (process.env.DEEPLINK || "").trim();
// "live_stand"/"live_ende": Beispiel-Spielstand als Datennachricht wie von sendLiveStand (App ab 1.11)
const art = (process.env.ART || "normal").trim();
const stand = (process.env.STAND || "12:10").trim();

if (!/^svo_test[a-z0-9_]*$/.test(topic)) {
  console.error(`Topic "${topic}" nicht erlaubt – nur Test-Topics, die mit "svo_test" beginnen.`);
  process.exit(1);
}
if (deeplink && !/^https:\/\/([a-z0-9-]+\.)*svohandball\.de\//.test(deeplink)) {
  console.error("Deeplink muss mit https://svohandball.de/ beginnen.");
  process.exit(1);
}

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
);

initializeApp({ credential: cert(serviceAccount) });

if (art === "live_stand" || art === "live_ende") {
  const [heimTore, gastTore] = stand.split(":");
  await getMessaging().send({
    topic,
    data: {
      kind: art, team: "svo_test", teamLabel: "Test", eventKey: "test",
      heim: "SV Obrigheim", gast: "HSG Hohenlohe", heimTore, gastTore,
      ticker: "https://spo.handball4all.de/service/ticker.html?appid=test&token=test",
      deeplink: deeplink || "https://svohandball.de/de/app/herren.php",
    },
    android: { priority: "high", ttl: 10 * 60 * 1000 },
  });
  console.log("Sent", art, stand, "to", topic);
} else {
  await getMessaging().send({
    topic,
    notification: { title, body },
    data: { kind: "test", ...(deeplink ? { deeplink } : {}) },
  });
  console.log("Sent test push to", topic, deeplink ? `(deeplink ${deeplink})` : "");
}
