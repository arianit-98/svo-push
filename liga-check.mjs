// Tägliche Prüfung der Liga-IDs (Workflow "Liga-Check"). Schlägt fehl, wenn eine Liga nicht passt;
// GitHub schickt dann eine Mail. Vor allem für den Saisonwechsel: Bleibt eine alte Liga-ID stehen,
// gehen sonst einfach keine Erinnerungen mehr raus, ohne dass es auffällt.
//
// Geprüft werden beide Stellen mit Liga-IDs:
//   - FEEDS in feeds.mjs (Push-Erinnerungen)
//   - TEAMS der Website-Widgets und Homescreen-Widgets, gelesen über svo-widget.php?teams
//
// Aufruf: node liga-check.mjs   (rund 8 Abfragen bei Handball4all, eine pro Liga)
import fs from "fs";
import { DateTime } from "luxon";
import { FEEDS, H4A_URL } from "./feeds.mjs";

const TZ = "Europe/Berlin";
const TEAMS_URL = "https://svohandball.de/de/app/svo-widget.php?teams";

const jetzt = DateTime.now().setZone(TZ);
// Kommende Spiele erwarten wir nur am Saisonanfang (September bis Dezember). Im Frühjahr sind
// manche Jugendrunden schon durch, im Sommer ist Pause.
const SAISON_START = jetzt.month >= 9 && jetzt.month <= 12;
// Eine noch leere Liga (Spielplan nicht veröffentlicht) ist bis Ende Oktober in Ordnung
const LEER_ERLAUBT = jetzt.month >= 5 && jetzt.month <= 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function laden(url) {
  let fehler;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "svo-push-liga-check/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      fehler = e;
      await sleep(3000 * i);
    }
  }
  throw fehler;
}

// Jede Liga nur einmal laden, mit Pause dazwischen (Handball4all drosselt)
const ligen = new Map();
async function liga(classId) {
  if (!ligen.has(classId)) {
    if (ligen.size) await sleep(1500);
    ligen.set(classId, laden(`${H4A_URL}?cmd=ps&og=216&cl=${classId}&ca=1`).then((d) => {
      const c = Array.isArray(d) ? d[0]?.content : null;
      if (!c) throw new Error("unerwartete Antwort");
      return { name: String(d[0]?.head?.name || "").trim(), spiele: [...(c.actualGames?.games || []), ...(c.futureGames?.games || [])] };
    }));
  }
  return ligen.get(classId);
}

const norm = (s) => String(s ?? "").trim().toLowerCase();
function anpfiff(g) {
  return DateTime.fromFormat(`${String(g.gDate).trim()} ${String(g.gTime).trim()}`, "dd.LL.yy HH:mm", { zone: TZ });
}

// passt(name) entscheidet wie die jeweilige Stelle: Push mit Teilstring, Widgets exakt
async function pruefe(quelle, label, classId, passt) {
  let l;
  try {
    l = await liga(classId);
  } catch (e) {
    return `${quelle} ${label} (Liga ${classId}): nicht ladbar (${e.message})`;
  }
  const unsere = l.spiele.filter((g) => passt(g.gHomeTeam) || passt(g.gGuestTeam));
  const kommend = unsere.filter((g) => anpfiff(g).isValid && anpfiff(g) > jetzt);
  console.log(`${quelle} ${label} (Liga ${classId}, ${l.name || "?"}): ${l.spiele.length} Spiele, davon ${unsere.length} unsere, ${kommend.length} kommend`);
  if (!l.spiele.length) {
    return LEER_ERLAUBT ? null : `${quelle} ${label} (Liga ${classId}): Spielplan leer – Liga-ID noch aktuell?`;
  }
  if (!unsere.length) {
    const namen = [...new Set(l.spiele.flatMap((g) => [String(g.gHomeTeam).trim(), String(g.gGuestTeam).trim()]))].sort();
    return `${quelle} ${label} (Liga ${classId}, ${l.name}): unser Team kommt nicht vor – Liga-ID oder Name falsch? Namen in der Liga: ${namen.join(", ")}`;
  }
  if (SAISON_START && !kommend.length) {
    return `${quelle} ${label} (Liga ${classId}, ${l.name}): keine kommenden Spiele – neue Saison, neue Liga-ID?`;
  }
  return null;
}

const probleme = [];

for (const f of FEEDS) {
  const p = await pruefe("Push", f.teamLabel, f.classId, (n) => norm(n).includes(norm(f.teamMatch)));
  if (p) probleme.push(p);
}

try {
  const { teams } = await laden(TEAMS_URL);
  for (const t of teams) {
    const p = await pruefe("Website/App", t.label, t.classId, (n) => norm(n) === norm(t.games));
    if (p) probleme.push(p);
  }
} catch (e) {
  probleme.push(`Website/App: Teamliste ${TEAMS_URL} nicht ladbar (${e.message})`);
}

const bericht = probleme.length
  ? `## ⚠️ Liga-Check: ${probleme.length} Problem(e)\n\n${probleme.map((p) => `- ${p}`).join("\n")}\n\nLiga-IDs stehen in \`feeds.mjs\` (svo-push) und in \`TEAMS\` in \`website/spielplaene/widget.html\` (svo-app).\n`
  : `## ✅ Liga-Check: alle Ligen in Ordnung\n`;
console.log("\n" + bericht);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, bericht);
process.exit(probleme.length ? 1 : 0);
