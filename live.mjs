// Entscheidung für den Live-Spielstand (sendLiveStand in index.mjs), ohne Netz testbar:
// node scripts/live-test.mjs
import { DateTime } from "luxon";

// Stand neu senden, wenn er sich ändert, sonst spätestens nach so vielen Minuten (die App blendet ihn
// nach 20 min ohne Nachricht aus)
export const LIVE_ERNEUERN_MINUTES = 10;

// Liefert { art: "live_stand" | "live_ende", stand: "12:10" } oder null.
// vorher: letzter Eintrag aus state.live ({ stand, at, ende? }) oder undefined.
// endeAbMinuten: vorher gilt "nicht live" als Pause, nicht als Spielende. Handball4all meldet in der
// Halbzeit kurz live: false und keine Tore (25.10.2026: "Abpfiff 0:0" zur Halbzeit, danach kam nichts mehr).
export function liveAktion(vorher, game, now, endeAbMinuten) {
  if (game.spieltag) return null;
  const alt = vorher ? DateTime.fromISO(vorher.at) : null;
  const faellig = !alt?.isValid || now >= alt.plus({ minutes: LIVE_ERNEUERN_MINUTES });

  if (liveLaeuft(game, now)) {
    const stand = liveStand(game, vorher);
    // Auch nach einem (vermeintlichen) Ende wieder aufnehmen, wenn H4A erneut live meldet
    if (!vorher || vorher.ende || vorher.stand !== stand || faellig) return { art: "live_stand", stand };
    return null;
  }
  if (!vorher || vorher.ende) return null;
  if (now < game.start.plus({ minutes: endeAbMinuten })) {
    // Pause: letzten Stand stehen lassen und rechtzeitig erneuern, damit die App ihn nicht ausblendet
    return faellig ? { art: "live_stand", stand: vorher.stand } : null;
  }
  return { art: "live_ende", stand: liveStand(game, vorher) };
}

// Spiel läuft laut H4A und liegt im Live-Fenster (−30 min bis +3 h ab Anpfiff)
export function liveLaeuft(game, now) {
  if (game.spieltag || !game.live) return false;
  return now >= game.start.minus({ minutes: 30 }) && now <= game.start.plus({ hours: 3 });
}

// Live-Anzeige ist offen (gesendet, noch kein Ende), z.B. in der Halbzeit: weiter abfragen
export function liveOffen(vorher, game, now) {
  return !!vorher && !vorher.ende && now <= game.start.plus({ hours: 3 });
}

// Stand aus H4A; fehlen die Tore (Halbzeit, Ticker geschlossen), der zuletzt gesendete
export function liveStand(game, vorher) {
  if (game.homeGoals === null || game.guestGoals === null) return vorher?.stand ?? "0:0";
  return `${game.homeGoals}:${game.guestGoals}`;
}
