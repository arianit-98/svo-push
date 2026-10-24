// Prüft liveAktion (live.mjs) ohne Handball4all und ohne Firebase: node scripts/live-test.mjs
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { liveAktion } from "../live.mjs";

const start = DateTime.fromISO("2026-10-25T15:00:00+01:00");
const spiel = (o) => ({ start, live: true, homeGoals: 12, guestGoals: 10, ...o });
const um = (min) => start.plus({ minutes: min });

assert.equal(liveAktion(undefined, spiel({ live: false }), um(10)), null, "nicht live, nie gesendet");
assert.equal(liveAktion(undefined, spiel({ homeGoals: null, guestGoals: null }), um(0)), "live_stand", "erster Stand 0:0");
assert.equal(liveAktion({ stand: "12:10", at: um(20).toISO() }, spiel(), um(25)), null, "gleicher Stand, frisch");
assert.equal(liveAktion({ stand: "11:10", at: um(20).toISO() }, spiel(), um(25)), "live_stand", "neuer Stand");
assert.equal(liveAktion({ stand: "12:10", at: um(20).toISO() }, spiel(), um(30)), "live_stand", "nach 10 min erneuern");
assert.equal(liveAktion({ stand: "12:10", at: um(80).toISO() }, spiel({ live: false }), um(85)), "live_ende", "Ticker aus -> Ende");
assert.equal(liveAktion({ stand: "12:10", at: um(80).toISO(), ende: true }, spiel({ live: false }), um(90)), null, "Ende nur einmal");
assert.equal(liveAktion({ stand: "12:10", at: um(170).toISO() }, spiel(), um(185)), "live_ende", "Ticker vergessen -> Ende nach 3 h");
assert.equal(liveAktion(undefined, spiel(), um(-40)), null, "zu früh");
assert.equal(liveAktion(undefined, spiel({ spieltag: true }), um(10)), null, "E-Jugend nie");
console.log("live-test: alles ok");
