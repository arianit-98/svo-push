import admin from "firebase-admin";

const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SA_B64, "base64").toString("utf8")
);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const topic = process.env.TOPIC || "team_herren_h1";

await admin.messaging().send({
  topic,
  notification: {
    title: "SVO Push Test ✅",
    body: "Wenn du das siehst, funktioniert GitHub → Firebase → Handy."
  },
  data: { kind: "test" }
});

console.log("Sent test push to", topic);
