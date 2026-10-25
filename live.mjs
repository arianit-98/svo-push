// Entscheidung für den Live-Spielstand (sendLiveStand in index.mjs), ohne Netz testbar:
// node scripts/live-test.mjs
import { DateTime } from "luxon";

// Stand neu senden, wenn er sich ändert, sonst spätestens nach so vielen Minuten
export const LIVE_ERNEUERN_MINUTES = 10;

// Liefert "live_stand", "live_ende" oder null.
// vorher: letzter Eintrag aus state.live ({ stand, at, ende? }) oder undefined
export function liveAktion(vorher, game, now) {
  if (game.spieltag) return null;
  if (liveLaeuft(game, now)) {
    if (!vorher || vorher.ende) return vorher?.ende ? null : "live_stand";
    const alt = DateTime.fromISO(vorher.at);
    if (vorher.stand !== liveStand(game) || !alt.isValid || now >= alt.plus({ minutes: LIVE_ERNEUERN_MINUTES })) {
      return "live_stand";
    }
    return null;
  }
  return vorher && !vorher.ende ? "live_ende" : null;
}

// Spiel läuft laut H4A und liegt im Live-Fenster (−30 min bis +3 h ab Anpfiff)
export function liveLaeuft(game, now) {
  if (game.spieltag || !game.live) return false;
  return now >= game.start.minus({ minutes: 30 }) && now <= game.start.plus({ hours: 3 });
}

export function liveStand(game) {
  return `${game.homeGoals ?? 0}:${game.guestGoals ?? 0}`;
}
