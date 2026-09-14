import { initializeApp, cert } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
);

initializeApp({ credential: cert(serviceAccount) });

const topic = process.env.TOPIC || "team_herren_h1";

await getMessaging().send({
  topic,
  notification: {
    title: "SVO Push Test ✅",
    body: "Wenn du das siehst, funktioniert GitHub → Firebase → Handy."
  },
  data: { kind: "test" }
});

console.log("Sent test push to", topic);
