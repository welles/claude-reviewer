# claude-reviewer

KI-Review für Pull Requests als wiederverwendbarer GitHub-Workflow. Claude prüft jeden PR mit dem
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) über die Anthropic
API, setzt Funde als Kommentare an die Zeilen und gibt den PR frei oder verlangt Änderungen, wie ein
menschlicher Reviewer. Bezahlt wird aus dem API-Guthaben des Schlüssels, nicht aus einem
Claude-Abo; das Review läuft deshalb nicht über `anthropics/claude-code-action`, die sich als
Claude Code meldet.

Alles, was der Reviewer braucht (Workflow, Skripte, Prompt, Schema, Lockfile des SDK), liegt hier.
Ein Repo bindet ihn mit einer Workflow-Datei und drei Secrets ein.

## Ablauf

- Bei jedem neuen oder aktualisierten PR: ein **Review** mit `claude-opus-5-5`. Ein neuer Push
  bricht ein laufendes automatisches Review desselben PRs ab.
- Gründlicheres Review auf Wunsch: das Label `claude-review` setzen. Das läuft einmal mit
  `claude-fable-5-1`, wird von Pushes nicht abgebrochen und entfernt das Label, sobald es gepostet
  ist. Schlägt es fehl, bleibt das Label stehen; dann es entfernen und neu setzen.
- Jeder Fund erscheint als Kommentar an der Zeile (🔴 Kritisch, 🟠 Fehler oder 🟡 Hinweis, Bereich,
  Begründung, bei eindeutigen Lösungen ein Vorschlag zum Übernehmen und ein „Prompt für
  KI-Agenten“), dazu ein Zusammenfassungs-Kommentar, den jeder Lauf aktualisiert.
- **Urteil:** Solange ein Fund der Schwere `kritisch` oder `fehler` offen ist, verlangt der
  Reviewer Änderungen (Request changes), sonst gibt er frei (Approve). Hinweise blockieren nicht.
- **Offen** heißt: der Thread des Funds ist nicht aufgelöst. Jeder Lauf prüft die offenen Funde
  früherer Läufe am neuen Stand; was behoben ist, bekommt eine kurze Antwort und wird aufgelöst.
  Trifft ein Fund nicht zu, löst ihn ein Mensch auf; der Reviewer meldet ihn dann nicht erneut.
- Das Urteil entsteht aus den offenen Funden im Workflow, nicht aus einer Entscheidung des Modells.
  Ein Review eines Stands, der nicht mehr der neueste ist, postet seine Funde, setzt aber kein
  Urteil.

## Sicherheit

- Claude darf nur lesen (`Read`, `Grep`, `Glob`), und zwar nur den ausgecheckten Stand und die
  Dateien vom PR; ein Hook lehnt jeden anderen Pfad ab. Es hat keine Shell, kein Netz, kein
  GitHub-Token und lädt keine Einstellungen, Hooks oder MCP-Server aus dem Repo.
- Gepostet wird in einem eigenen Job mit Schreibrechten, in dem kein Code des PRs läuft.
- Skripte, Prompt und SDK kommen aus diesem Repo, genau vom Commit des aufgerufenen Workflows
  (`job.workflow_sha`), nie aus dem PR. Das SDK wird mit `npm ci` aus dem Lockfile installiert.
- Nur `pull_request`-Events; PRs aus Forks und von Bots werden nicht geprüft.
- Ein PR könnte versuchen, das Modell zu einer Freigabe zu überreden (Anweisungen im Code oder in
  der Beschreibung). Der Prompt weist das an, und das Modell kann nur eigene Threads auflösen, aber
  eine Garantie ist das nicht. Die Freigabe ersetzt kein menschliches Review, sobald andere Leute
  PRs öffnen.

## Einbinden

1. **Workflow:** [`examples/claude-review.yml`](examples/claude-review.yml) nach
   `.github/workflows/claude-review.yml` kopieren.
2. **API-Schlüssel:** Secret `ANTHROPIC_REVIEW_KEY` unter Settings → Secrets and variables →
   Actions, ein Schlüssel aus der [Anthropic Console](https://platform.claude.com/).
3. **GitHub App** (empfohlen, damit das Review unter eigenem Namen erscheint):
   1. Settings → Developer settings → GitHub Apps → New GitHub App. Name z. B. `claude-reviewer`,
      Homepage-URL dieses Repo, Webhook aus.
   2. Repository permissions: **Pull requests: Read and write** (Metadata: Read-only kommt
      automatisch). Nur auf diesem Account installierbar.
   3. Unter „Private keys“ einen Schlüssel erzeugen; die *Client ID* steht oben auf der Seite.
   4. „Install App“ → nur die Repos auswählen, die geprüft werden sollen.
   5. Im Repo die Secrets `REVIEWER_APP_CLIENT_ID` (Client ID) und `REVIEWER_APP_KEY` (Inhalt der
      `.pem`-Datei) anlegen.

   Ohne App postet `github-actions`. Freigeben kann es nur, wenn unter Settings → Actions → General
   „Allow GitHub Actions to create and approve pull requests“ an ist; sonst steht im Log eine
   Warnung und die Funde werden trotzdem gepostet.
4. **Label** `claude-review` unter Issues → Labels anlegen.
5. **Projekt-Anweisungen** (optional): `.github/review-instructions.md` mit Projekt, Schwerpunkten
   und Bereichen der Funde, Aufbau wie
   [`review-instructions.default.md`](review-instructions.default.md). Ohne die Datei gilt diese
   Vorlage.
6. **Branch Protection / Ruleset** (damit das Urteil zählt): „Require a pull request before merging“
   mit mindestens einer Freigabe und „Dismiss stale pull request approvals when new commits are
   pushed“. Ohne das bleibt das Urteil sichtbar, blockiert aber keinen Merge.

Secrets lassen sich auch mit `gh` setzen:

```bash
gh secret set REVIEWER_APP_KEY -R <owner>/<repo> < claude-reviewer.private-key.pem
```

## Eingaben

| Eingabe | Standard | |
| --- | --- | --- |
| `model` | `claude-opus-5-5` | Modell des automatischen Reviews |
| `thorough-model` | `claude-fable-5-1` | Modell des gründlichen Reviews |
| `label` | `claude-review` | Label für das gründliche Review, Präfix der versteckten Marker |
| `reviewer-name` | `Claude` | Name in der Zusammenfassung |
| `instructions` | `.github/review-instructions.md` | Projekt-Anweisungen im Repo |
| `verdict` | `true` | Freigeben/Änderungen verlangen statt nur kommentieren |
| `blocking-severities` | `kritisch,fehler` | Schweren, die Änderungen verlangen |
| `max-turns` | `60` | Obergrenze an Schritten pro Review |
| `max-budget-usd` | `5` | Obergrenze an API-Kosten pro Review |

## Versionen

Repos binden `@v1` ein. Änderungen hier wirken erst, wenn der Tag verschoben wird:

```bash
git tag -f -m v1 v1 && git push -f origin v1
```

Inkompatible Änderungen (andere Secrets, anderes Format der Marker) bekommen `v2`.

## Kosten und Abschalten

Was ein Lauf gekostet hat, steht im Log unter „Claude“ (z. B. „claude-opus-5-5: 8 turns, 0.22 $“);
schlägt ein Lauf fehl, steht dort der Grund der API (z. B. „Credit balance is too low“). Reviews
kleiner PRs kosteten mit Opus 0,14 bis 0,34 $, ein gründliches mit Fable etwa 1,70 $. Ein Lauf
bricht nach `max-turns` Schritten oder `max-budget-usd` ab.

Abschalten: im Repo unter Actions → Claude Review → … → Disable workflow.
