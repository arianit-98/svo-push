// Prüft liveAktion (live.mjs) ohne Handball4all und ohne Firebase: node scripts/live-test.mjs
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { liveAktion } from "../live.mjs";

const start = DateTime.fromISO("2026-10-25T15:00:00+01:00");
const spiel = (o) => ({ start, live: true, homeGoals: 12, guestGoals: 10, ...o });
const um = (min) => start.plus({ minutes: min });
const art = (...a) => liveAktion(...a, 75)?.art ?? null;
const stand = (...a) => liveAktion(...a, 75)?.stand ?? null;
const pause = { live: false, homeGoals: null, guestGoals: null };

assert.equal(art(undefined, spiel({ live: false }), um(10)), null, "nicht live, nie gesendet");
assert.equal(stand(undefined, spiel({ homeGoals: null, guestGoals: null }), um(0)), "0:0", "erster Stand 0:0");
assert.equal(art({ stand: "12:10", at: um(20).toISO() }, spiel(), um(25)), null, "gleicher Stand, frisch");
assert.equal(art({ stand: "11:10", at: um(20).toISO() }, spiel(), um(25)), "live_stand", "neuer Stand");
assert.equal(art({ stand: "12:10", at: um(20).toISO() }, spiel(), um(30)), "live_stand", "nach 10 min erneuern");
// Halbzeit wie am 25.10.2026: live false, keine Tore
assert.equal(art({ stand: "14:14", at: um(43).toISO() }, spiel(pause), um(45)), null, "Halbzeit: kein Ende");
assert.equal(stand({ stand: "14:14", at: um(43).toISO() }, spiel(pause), um(54)), "14:14", "Halbzeit: letzter Stand erneuert");
assert.equal(art({ stand: "14:14", at: um(45).toISO(), ende: true }, spiel({ homeGoals: 15, guestGoals: 14 }), um(56)), "live_stand", "nach falschem Ende wieder aufnehmen");
assert.equal(stand({ stand: "14:14", at: um(50).toISO() }, spiel({ homeGoals: null, guestGoals: null }), um(55)), null, "live ohne Tore: Stand bleibt, nichts senden");
// Echtes Ende
assert.equal(art({ stand: "32:26", at: um(95).toISO() }, spiel({ live: false, homeGoals: 32, guestGoals: 26 }), um(98)), "live_ende", "Ticker aus nach Spielzeit -> Ende");
assert.equal(stand({ stand: "32:26", at: um(95).toISO() }, spiel(pause), um(98)), "32:26", "Ende ohne Tore: letzter Stand");
assert.equal(art({ stand: "32:26", at: um(98).toISO(), ende: true }, spiel({ live: false }), um(100)), null, "Ende nur einmal");
assert.equal(art({ stand: "12:10", at: um(170).toISO() }, spiel(), um(185)), "live_ende", "Ticker vergessen -> Ende nach 3 h");
assert.equal(art(undefined, spiel(), um(-40)), null, "zu früh");
assert.equal(art(undefined, spiel({ spieltag: true }), um(10)), null, "E-Jugend nie");
console.log("live-test: alles ok");
