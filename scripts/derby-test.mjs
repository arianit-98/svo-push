// Prüft den Derby-Modus (derby.mjs) ohne Handball4all und ohne Firebase: node scripts/derby-test.mjs
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { FEEDS } from "../feeds.mjs";
import { derbyFuer, derbyErinnerung, derbyLiveTitel, derbyHalbzeit, derbyErgebnis } from "../derby.mjs";

const TZ = "Europe/Berlin";
const herren = FEEDS.find((f) => f.teamKey === "herren");
const herren2 = FEEDS.find((f) => f.teamKey === "herren2");
const zeit = (iso) => DateTime.fromISO(iso, { zone: TZ });
const derbySpiel = { opponent: "HA Neckarelz", homeAway: "away", start: zeit("2026-11-14T20:00") };
const rueckspiel = { opponent: "HA Neckarelz", homeAway: "home", start: zeit("2027-01-23T18:00") };
const jetzt = zeit("2026-11-10T20:00");

// Erkennung
const d = derbyFuer(herren, derbySpiel, jetzt);
assert.ok(d, "Hinspiel ist Derby");
assert.equal(d.deeplink, "https://svohandball.de/de/app/derby.php");
const r = derbyFuer(herren, rueckspiel, jetzt);
assert.ok(r && r !== d, "Rückspiel hat eigenen Eintrag, auch schon vor dem Hinspiel");
assert.equal(r.deeplink, undefined, "Rückspiel: normaler Link (herren.php)");
assert.equal(derbyErinnerung(r, "h1").zeile, "Ab in die Neckarhalle!");
assert.equal(derbyFuer(herren, { ...derbySpiel, opponent: "TSV Wieblingen" }, jetzt), null, "anderer Gegner am Derbytag");
assert.equal(derbyFuer(herren, { ...derbySpiel, start: zeit("2026-12-05T20:00") }, jetzt), null, "Neckarelz an anderem Tag");
assert.ok(derbyFuer(herren, derbySpiel, zeit("2026-11-16T19:00")), "Ergebnis bis 48 h danach noch Derby");
assert.equal(derbyFuer(herren2, derbySpiel, jetzt), null, "anderes Team");
assert.equal(derbyFuer(herren, { ...derbySpiel, spieltag: true }, jetzt), null, "nie bei Spieltagen");

// Texte
assert.deepEqual(derbyErinnerung(d, "d4"), { titel: "🔥 Neckar-Derby in 4 Tagen! 💛💙", zeile: "Germanen gegen Piranhas" });
assert.deepEqual(derbyErinnerung(d, "d1"), { titel: "🔥 Morgen ist Neckar-Derby! 💛💙", zeile: "Germanen gegen Piranhas" });
assert.deepEqual(derbyErinnerung(d, "h1"), { titel: "🔥 In einer Stunde: Neckar-Derby! 💛💙", zeile: "Ab in die Pattberghalle!" });
assert.equal(derbyLiveTitel(d), "🔴 Das Neckar-Derby läuft! 💛💙");
// Auswärts: Heim = Neckarelz, Gast = SVO
assert.equal(derbyHalbzeit(d, "away", "12", "14").zeile, "Wir führen!");
assert.equal(derbyHalbzeit(d, "away", "14", "12").zeile, "Wir liegen hinten.");
assert.equal(derbyHalbzeit(d, "away", "13", "13").zeile, "Alles offen!");
assert.equal(derbyHalbzeit(d, "home", "14", "12").zeile, "Wir führen!", "Heimspiel (Rückspiel)");
assert.equal(derbyHalbzeit(d, "away", "1", "0").titel, "⏸️ Halbzeit im Neckar-Derby 💛💙");
assert.deepEqual(derbyErgebnis(d, "away", 24, 28), { titel: "🏆 DERBYSIEG! 💛💙", zeile: "Die Neckar-Hoheit liegt in Obrigheim!" });
assert.deepEqual(derbyErgebnis(d, "away", 28, 24), { titel: "❌ Derby verloren 💛💙", zeile: null });
assert.deepEqual(derbyErgebnis(d, "away", 26, 26), { titel: "🤝 Derby-Remis 💛💙", zeile: null });
console.log("derby-test: alles ok");
