# Lumen Chat Web

Eine passwortgeschützte Webversion von Lumen Chat mit Chat über Groq und Bildgenerierung über OpenAI. `index.html`, `style.css` und `script.js` bilden die Oberfläche. `server.mjs` stellt die Seite bereit und verwaltet Passwort, Sitzungen und API-Schlüssel serverseitig.

## Lokal mit VS Code starten

1. Installiere [Node.js 20 oder neuer](https://nodejs.org/).
2. Öffne diesen Ordner in VS Code.
3. Kopiere `.env.example` nach `.env`, falls `.env` noch nicht existiert. Trage die Werte dort ein:

   ```env
   SITE_PASSWORD=dein_langes_zugangspasswort
   GROQ_API_KEY=dein_groq_schluessel
   OPENAI_API_KEY=dein_openai_schluessel
   GROQ_MODEL=openai/gpt-oss-120b
   PORT=4174
   ```

4. Öffne das VS-Code-Terminal und starte den Server:

   ```powershell
   npm.cmd start
   ```

5. Öffne <http://127.0.0.1:4174>. Zum Beenden drückst du im Terminal `Strg+C`.

Es werden keine zusätzlichen npm-Pakete benötigt. Nach Änderungen an `.env` muss der Server neu gestartet werden. Auf Windows umgeht `npm.cmd start` die PowerShell-Sperre für `npm.ps1`.

## Öffentlich bereitstellen

Als kostenlose Testbereitstellung ist Render vorbereitet. Lege das Projekt in ein privates GitHub-Repository und verbinde dieses Repository mit Render. Erstelle dort eine **Blueprint-Instanz** aus `render.yaml`; Render baut den Docker-Container und fragt die drei geheimen Werte ab. Render erzeugt eine öffentliche `onrender.com`-Adresse samt HTTPS. Der Server erkennt diese Adresse automatisch. Eine eigene Domain ist nicht erforderlich.

Hinterlege diese Werte beim Hosting als **geheime Umgebungsvariablen**; lade `.env` niemals hoch:

| Variable | Wert |
| --- | --- |
| `SITE_PASSWORD` | Gemeinsames Zugangspasswort, mindestens 8 Zeichen |
| `PUBLIC_ORIGIN` | Nur bei eigener Domain setzen: vollständige HTTPS-Adresse, ohne Pfad oder abschließenden Schrägstrich. Für die Render-Adresse wird `RENDER_EXTERNAL_URL` automatisch verwendet. |
| `GROQ_API_KEY` | Dein Groq-API-Schlüssel |
| `OPENAI_API_KEY` | Dein OpenAI-API-Schlüssel |
| `GROQ_MODEL` | Optional; Standard: `openai/gpt-oss-120b` |
| `PORT` | Vom Anbieter bereitgestellter Port; lokal standardmäßig `4174` |

Für einen eigenen Docker-Host kannst du das Image mit `docker build -t lumen-chat .` erstellen. Die Anwendung bindet im öffentlichen Modus an `0.0.0.0`, verlangt HTTPS für öffentliche Domains und akzeptiert nur den Host der konfigurierten Adresse. Verwende zunächst **eine Server-Instanz**: Sitzungen und Fehlversuchszähler liegen im Arbeitsspeicher und laufen beim Neustart ab.

Render Free ist für Tests geeignet: Nach 15 Minuten ohne Aufruf wird der Dienst angehalten; der erste Aufruf danach kann ungefähr eine Minute zum Aufwachen brauchen. Kostenlose Instanzen können außerdem neu gestartet werden. Das Hosting ist kostenlos, aber OpenAI-Bildanfragen können weiterhin API-Kosten verursachen. Details stehen in der [Render-Dokumentation zu kostenlosen Diensten](https://render.com/docs/free).

Der Link ist öffentlich erreichbar, aber Anmeldung, Chat, Bildgenerierung und Status-API benötigen eine gültige Sitzung. Das Login-Cookie ist `HttpOnly`, `SameSite=Strict` und bei HTTPS `Secure`; nach acht falschen Passwortversuchen von derselben Netzwerkadresse wird der Login 15 Minuten gesperrt. Die API-Schlüssel werden nie an den Browser gesendet.

Das Passwort gilt gemeinsam für alle Besucher. Wer es kennt, kann die App nutzen. Chat-Anfragen werden an Groq gesendet. Für Bildanfragen erscheint jedes Mal eine Kostenbestätigung; die Bildqualität startet bei **Hoch** und OpenAI kann die Nutzung berechnen. Siehe die aktuelle [OpenAI-Preisübersicht](https://developers.openai.com/api/docs/pricing).

Gespräche liegen im Browser-Speicher des jeweiligen Geräts und sind dort nicht verschlüsselt. Auf einem geteilten Gerät können andere Personen den Verlauf im selben Browser sehen. Generierte Bilder bleiben bis zum Neuladen in der Vorschau und lassen sich über **PNG speichern** herunterladen.

## API-Schlüssel

- Groq: [console.groq.com/keys](https://console.groq.com/keys)
- OpenAI: [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

Lokale Schlüssel gehören nur in `.env`. Diese Datei ist von Git und Docker ausgeschlossen. Bei einer öffentlichen Bereitstellung kommen Schlüssel ausschließlich in die geschützte Variablenverwaltung des Hosting-Anbieters. Widerrufe API-Schlüssel, die bereits in einem öffentlichen Chat oder Repository geteilt wurden, und verwende neue.
