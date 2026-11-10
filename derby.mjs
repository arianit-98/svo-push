// Derby-Modus: Für ein Spiel gegen einen Gegner aus feed.derbys bekommen die normalen Pushes des Teams
// (Erinnerungen, Liveticker, Halbzeit, Ergebnis, Live-Spielstand) eigene Titel, eine Zusatzzeile und den
// Link auf die Derby-Seite. Topics, Empfänger, Zeitpunkte und collapse-IDs bleiben gleich.
// Reine Funktionen ohne Netz, geprüft mit: node scripts/derby-test.mjs
import { DateTime } from "luxon";

const TZ = "Europe/Berlin";

// Derby-Eintrag für ein Spiel oder null. bis = letzter Tag (einschließlich), an dem Texte und Link gelten.
export function derbyFuer(feed, game, now) {
  if (!feed.derbys || game.spieltag) return null;
  return feed.derbys.find((d) => {
    if (!d.gegner.test(game.opponent || "")) return false;
    const bis = DateTime.fromISO(d.bis, { zone: TZ }).endOf("day");
    return bis.isValid && now <= bis;
  }) || null;
}

// Wer gerade vorne liegt, aus Sicht des SVO
function bilanz(homeAway, heim, gast) {
  const wir = Number(homeAway === "home" ? heim : gast);
  const die = Number(homeAway === "home" ? gast : heim);
  return wir > die ? "vorn" : wir < die ? "hinten" : "gleich";
}

// Erinnerung d4/d1/h1: Titel und die Zeile unter Paarung, Datum und Halle
export function derbyErinnerung(d, offKey) {
  const titel = {
    d4: `🔥 ${d.name} in 4 Tagen! 💛💙`,
    d1: `🔥 Morgen ist ${d.name}! 💛💙`,
    h1: `🔥 In einer Stunde: ${d.name}! 💛💙`,
  }[offKey] || `🔥 ${d.name} 💛💙`;
  const zeile = offKey === "h1" && d.zeileH1 ? d.zeileH1 : d.zeile;
  return { titel, zeile };
}

export function derbyLiveTitel(d) {
  return `🔴 Das ${d.name} läuft! 💛💙`;
}

export function derbyHalbzeit(d, homeAway, heim, gast) {
  const b = bilanz(homeAway, heim, gast);
  return {
    titel: `⏸️ Halbzeit im ${d.name} 💛💙`,
    zeile: b === "vorn" ? "Wir führen!" : b === "hinten" ? "Wir liegen hinten." : "Alles offen!",
  };
}

// Ergebnis: Titel, bei einem Sieg zusätzlich der Spruch; bei Niederlage/Remis nüchtern, ohne Spruch
export function derbyErgebnis(d, homeAway, heim, gast) {
  const b = bilanz(homeAway, heim, gast);
  if (b === "vorn") return { titel: "🏆 DERBYSIEG! 💛💙", zeile: d.sieg || null };
  if (b === "hinten") return { titel: "❌ Derby verloren 💛💙", zeile: null };
  return { titel: "🤝 Derby-Remis 💛💙", zeile: null };
}
