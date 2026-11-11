# Worauf das KI-Review achtet

Allgemeine Vorlage des Reviewers. Das Repo hat keine eigene `.github/review-instructions.md`; mit
einer eigenen Datei lassen sich Projekt, Schwerpunkte und Bereiche festlegen (Aufbau wie hier).

## Projekt

Keine Beschreibung vorhanden. Erschließe aus README, AGENTS.md und der Struktur des Repos, was das
Projekt ist und welche Regeln gelten.

## Besonders prüfen

- Fehler im Verhalten: falsche Bedingungen, Grenzfälle, Fehlerbehandlung, Nebenläufigkeit.
- Sicherheit: Geheimnisse im Klartext, fehlende Prüfung von Eingaben, zu weite Rechte.
- Daten: Verlust oder Beschädigung von Daten, Migrationen, die nicht zurückgehen.
- Betrieb: Änderungen, durch die ein Build, ein Deployment oder ein Start fehlschlägt.

## Hinweise

`hinweis` sind z. B. Verstöße gegen die Regeln in AGENTS.md und kleine Risiken.

## Bereiche

Sicherheit, Funktion, Daten, Projektregeln, Betrieb
