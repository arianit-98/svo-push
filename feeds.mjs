// Teams und Ligen, gemeinsam genutzt von index.mjs (Scheduler) und liga-check.mjs (tägliche Prüfung).

// Teams / Handball4all-Ligen
// Die handball.net-ICS-Feeds gibt es nicht mehr (404). Wir holen den Spielplan der Liga direkt
// von Handball4all – dieselbe Quelle wie h4a-proxy.php auf svohandball.de.
// ⚠️ Die Liga-ID (classId) ändert sich jede Saison und muss dann hier aktualisiert werden.
//    classId steht in der Spielplan-URL auf handball4all.de (Parameter "cl").
// teamMatch: Teil des Mannschaftsnamens, wie er in gHomeTeam/gGuestTeam steht.
// resultMinMinutes: Ergebnis-Push frühestens so lange nach Anpfiff (Spielzeit + Pause + Puffer).
//   Läuft ein Liveticker, stehen während des Spiels schon Zwischenstände in gHomeGoals/gGuestGoals;
//   das Feld "live" sollte das anzeigen, die Grenze ist die zweite Absicherung.
export const H4A_URL = "https://spo.handball4all.de/service/if_g_json.php";

// deeplink: versteckte Seite pro Team (nur Spielplan + Tabelle, nicht im Menü, noindex) unter
// /de/app/<team>.php. Muss https auf svohandball.de sein, sonst verwirft die App den Link.
export const FEEDS = [
  {
    teamKey: "herren",
    teamLabel: "Herren 1",
    clubShort: "SVO",
    org: 216,          // Baden-Württembergischer Handball-Verband
    classId: 161161,   // Männer-Landesliga Staffel 1, Saison 26/27
    teamMatch: "SV Obrigheim",
    deeplink: "https://svohandball.de/de/app/herren.php",
    resultMinMinutes: 75, // 2 × 30 min
  },
  {
    teamKey: "herren2",
    teamLabel: "Herren 2",
    clubShort: "SVO 2",
    org: 216,
    classId: 161571,   // Männer 2. Bezirksklasse Gruppe 1, Saison 26/27
    teamMatch: "SV Obrigheim 2",
    deeplink: "https://svohandball.de/de/app/herren2.php",
    resultMinMinutes: 75, // 2 × 30 min
  },
  {
    teamKey: "c1",     // Key bleibt "c1", damit bestehende Abos (team_c1_*) weiter funktionieren
    teamLabel: "C-Jugend",
    clubShort: "JSG",
    org: 216,
    classId: 165801,   // mC-Jugend Bezirksklasse Gruppe 1, Saison 26/27
    teamMatch: "Neck-Obrig",   // "JSG Neck-Obrig"
    deeplink: "https://svohandball.de/de/app/c-jugend.php",
    resultMinMinutes: 65, // 2 × 25 min
  },
  {
    teamKey: "b1",
    teamLabel: "B-Jugend",
    clubShort: "JSG",
    org: 216,
    classId: 165711,   // mB-Jugend Bezirksliga Gruppe 1, Saison 26/27
    teamMatch: "Neck-Obrig",
    deeplink: "https://svohandball.de/de/app/b-jugend.php",
    resultMinMinutes: 65, // 2 × 25 min
  },
  {
    teamKey: "d1jugend", // nicht "d1", sonst hieße das Topic team_d1_d1 (Offset heißt auch d1)
    teamLabel: "D1-Jugend",
    clubShort: "JSG",
    org: 216,
    classId: 166111,   // mD-Jugend, Saison 26/27
    teamMatch: "JSG Neck-Obrig",
    deeplink: "https://svohandball.de/de/app/d1-jugend.php",
    resultMinMinutes: 55, // 2 × 20 min
  },
  {
    teamKey: "d2jugend",
    teamLabel: "D2-Jugend",
    clubShort: "JSG 2",
    org: 216,
    classId: 166131,   // mD-Jugend, Saison 26/27
    teamMatch: "JSG Neck-Obrig 2",
    deeplink: "https://svohandball.de/de/app/d2-jugend.php",
    resultMinMinutes: 55, // 2 × 20 min
  },
];
