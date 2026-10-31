import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const defaultChatModel = "openai/gpt-oss-120b";
const maximumImageBytes = 20 * 1024 * 1024;
const maximumImageResponseBytes = 28 * 1024 * 1024;
const maximumVoiceBytes = 20 * 1024 * 1024;
const maximumSpeechTextCharacters = 5_000;
const voiceMimeTypes = new Map([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
]);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

await loadLocalEnvironment(resolve(projectDirectory, ".env"));

const configuredPort = Number(process.env.PORT || 4173);
const port = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
  ? configuredPort
  : 4173;
const chatModel = safeModelName(process.env.GROQ_MODEL) || defaultChatModel;
const sitePassword = process.env.SITE_PASSWORD?.trim() || "";
const passwordDigest = createHash("sha256").update(sitePassword).digest();
const sessionCookieName = "malikai_session";
const sessionDurationSeconds = 12 * 60 * 60;
const sessionDurationMs = sessionDurationSeconds * 1000;
const loginWindowMs = 15 * 60 * 1000;
const loginAttemptLimit = 8;
const sessions = new Map();
const loginAttempts = new Map();

function configuredOrigin(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN muss eine gültige Website-Adresse sein.");
  }
  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.origin !== value.replace(/\/$/, "") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN darf nur aus Protokoll und Domain bestehen, ohne Pfad.");
  }
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("Eine öffentliche Website benötigt HTTPS in PUBLIC_ORIGIN.");
  }
  return url.origin;
}

const publicOrigin = configuredOrigin(process.env.PUBLIC_ORIGIN?.trim() || process.env.RENDER_EXTERNAL_URL?.trim() || "");
if (sitePassword.length < 8 || sitePassword.length > 256) {
  throw new Error("Bitte SITE_PASSWORD mit 8 bis 256 Zeichen in der .env-Datei oder beim Hosting setzen.");
}
const allowedHosts = new Set(publicOrigin
  ? [new URL(publicOrigin).host.toLowerCase()]
  : [`127.0.0.1:${port}`, `localhost:${port}`]);

const staticFiles = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/style.css", "style.css"],
  ["/mathjax-config.js", "mathjax-config.js"],
  ["/script.js", "script.js"],
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function loadLocalEnvironment(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;

    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[match[1]] = value;
  }
}

function safeModelName(value) {
  if (typeof value !== "string") return "";
  const model = value.trim();
  return /^[A-Za-z0-9._/-]{1,120}$/.test(model) ? model : "";
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  if (publicOrigin.startsWith("https://")) response.setHeader("Strict-Transport-Security", "max-age=31536000");
  response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'");
}

function sendJson(response, status, payload) {
  if (response.destroyed || response.headersSent) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function requireSameOriginBrowserRequest(request) {
  const host = String(request.headers.host || "").toLowerCase();
  const expectedOrigin = publicOrigin || `http://${host}`;
  if (request.headers.origin !== expectedOrigin) {
    throw new HttpError(403, "origin_rejected", "Die Anfrage stammt nicht von dieser Website.");
  }
}

function requestSessionToken(request) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== sessionCookieName) continue;
    return cookie.slice(separator + 1).trim();
  }
  return "";
}

function authenticatedSession(request) {
  const token = requestSessionToken(request);
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

function requireAuthenticatedSession(request) {
  if (!authenticatedSession(request)) {
    throw new HttpError(401, "authentication_required", "Bitte melde dich mit dem Zugangspasswort an.");
  }
}

function loginLimitKey(request) {
  return request.socket.remoteAddress || "unknown";
}

function checkLoginLimit(request, response) {
  const key = loginLimitKey(request);
  const now = Date.now();
  let attempt = loginAttempts.get(key);
  if (attempt && attempt.resetAt <= now) {
    loginAttempts.delete(key);
    attempt = null;
  }
  if (attempt?.blockedUntil > now) {
    response.setHeader("Retry-After", String(Math.ceil((attempt.blockedUntil - now) / 1000)));
    throw new HttpError(429, "login_rate_limited", "Zu viele Fehlversuche. Bitte warte 15 Minuten und versuche es erneut.");
  }
  return key;
}

async function handleLogin(request, response) {
  const key = checkLoginLimit(request, response);
  const body = await readJson(request, 1_024);
  const candidate = typeof body.password === "string" ? body.password : "";
  const candidateDigest = createHash("sha256").update(candidate.slice(0, 256)).digest();
  const matches = candidate.length <= 256 && timingSafeEqual(candidateDigest, passwordDigest);
  if (!matches) {
    const current = loginAttempts.get(key);
    const now = Date.now();
    const attempt = current && current.resetAt > now ? current : { count: 0, resetAt: now + loginWindowMs, blockedUntil: 0 };
    attempt.count += 1;
    if (attempt.count >= loginAttemptLimit) attempt.blockedUntil = now + loginWindowMs;
    loginAttempts.set(key, attempt);
    throw new HttpError(401, "invalid_password", "Das Passwort stimmt nicht. Bitte versuche es erneut.");
  }

  loginAttempts.delete(key);
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { expiresAt: Date.now() + sessionDurationMs });
  const secure = publicOrigin.startsWith("https://") ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDurationSeconds}${secure}`);
  sendJson(response, 200, { authenticated: true });
}

function handleLogout(request, response) {
  const token = requestSessionToken(request);
  if (token) sessions.delete(token);
  const secure = publicOrigin.startsWith("https://") ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  sendJson(response, 200, { authenticated: false });
}

async function readJson(request, maximumBytes = 96 * 1024) {
  const chunks = [];
  let byteCount = 0;

  for await (const chunk of request) {
    byteCount += chunk.length;
    if (byteCount > maximumBytes) {
      request.resume();
      throw new HttpError(413, "request_too_large", "Die Anfrage ist zu groß.");
    }
    chunks.push(chunk);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid object");
    return parsed;
  } catch {
    throw new HttpError(400, "invalid_request", "Die Anfrage enthält keine gültigen Daten.");
  }
}

function validateChatMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 80) {
    throw new HttpError(400, "invalid_messages", "Schreibe zuerst eine Nachricht für den Chat.");
  }

  let totalCharacters = 0;
  const messages = value.map((message) => {
    if (!message || typeof message !== "object" || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw new HttpError(400, "invalid_messages", "Die Chatnachricht hat ein ungültiges Format.");
    }
    const content = message.content.trim();
    if (!content || content.length > 8_000) {
      throw new HttpError(400, "invalid_messages", "Jede Chatnachricht darf höchstens 8.000 Zeichen enthalten.");
    }
    totalCharacters += content.length;
    return { role: message.role, content };
  });

  if (totalCharacters > 48_000) {
    throw new HttpError(400, "context_too_large", "Der Chat ist sehr lang. Starte bitte einen neuen Chat.");
  }
  return messages;
}

function chatProviderError(status) {
  if (status === 401 || status === 403) return new HttpError(401, "invalid_key", "Der Groq-Schlüssel ist ungültig. Prüfe deine .env-Datei.");
  if (status === 429) return new HttpError(429, "rate_limit", "Das Groq-Limit ist erreicht. Warte kurz und versuche es erneut.");
  if (status === 404) return new HttpError(400, "model_unavailable", "Das eingestellte Groq-Modell ist nicht verfügbar. Prüfe GROQ_MODEL in deiner .env-Datei.");
  if (status >= 500) return new HttpError(502, "provider_unavailable", "Groq ist gerade nicht erreichbar. Versuche es später erneut.");
  return new HttpError(502, "provider_error", "Groq konnte die Anfrage nicht bearbeiten. Prüfe Schlüssel und Modell.");
}

async function readRawAudio(request, maximumBytes) {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
    if (byteCount > maximumBytes) {
      request.resume();
      throw new HttpError(413, "audio_too_large", "Die Aufnahme ist zu groß. Bitte sprich kürzer.");
    }
    chunks.push(chunk);
  }
  if (byteCount === 0) throw new HttpError(400, "empty_audio", "Es wurde keine Audioaufnahme empfangen.");
  return Buffer.concat(chunks);
}

async function handleVoiceTranscription(request, response) {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new HttpError(503, "voice_unavailable", "Die Groq-Spracherkennung ist gerade nicht konfiguriert.");

  const mimeType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  const extension = voiceMimeTypes.get(mimeType);
  if (!extension) throw new HttpError(415, "unsupported_audio", "Dieses Mikrofonformat wird nicht unterstützt.");

  const audio = await readRawAudio(request, maximumVoiceBytes);
  if (audio.length < 256) throw new HttpError(400, "empty_audio", "Ich habe nichts Verständliches aufgenommen. Bitte versuche es erneut.");

  const form = new FormData();
  form.append("file", new Blob([audio], { type: mimeType }), `malikai-aufnahme.${extension}`);
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "de");
  form.append("response_format", "json");
  form.append("temperature", "0");

  let upstream;
  try {
    upstream = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpError(504, "voice_timeout", "Die Spracherkennung hat zu lange gebraucht. Bitte versuche es erneut.");
    }
    throw new HttpError(502, "voice_network", "Groq ist gerade nicht erreichbar. Bitte versuche es erneut.");
  }

  if (!upstream.ok) {
    if (upstream.status === 429) throw new HttpError(429, "voice_rate_limit", "Das Groq-Limit für Spracheingaben ist erreicht. Bitte warte kurz und versuche es erneut.");
    if (upstream.status === 401 || upstream.status === 403) throw new HttpError(502, "voice_key", "Der Groq-Schlüssel für die Spracherkennung ist ungültig.");
    if (upstream.status === 400 || upstream.status === 413 || upstream.status === 415) {
      throw new HttpError(400, "voice_invalid_audio", "Groq konnte diese Aufnahme nicht lesen. Bitte versuche es mit einer neuen Aufnahme.");
    }
    throw new HttpError(502, "voice_provider", "Groq konnte die Aufnahme gerade nicht verarbeiten.");
  }

  let payload;
  try { payload = await upstream.json(); }
  catch { throw new HttpError(502, "voice_provider", "Groq hat kein gültiges Transkript zurückgegeben."); }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) throw new HttpError(422, "voice_empty_transcript", "Ich habe keine Sprache erkannt. Bitte sprich näher am Mikrofon.");
  sendJson(response, 200, { text });
}

async function handleVoiceSpeech(request, response) {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!apiKey) throw new HttpError(503, "elevenlabs_missing_key", "Hinterlege ELEVENLABS_API_KEY zuerst in den Server-Umgebungsvariablen.");
  if (!voiceId || !/^[A-Za-z0-9_-]{1,128}$/.test(voiceId)) {
    throw new HttpError(503, "elevenlabs_missing_voice", "Hinterlege ELEVENLABS_VOICE_ID zuerst in den Server-Umgebungsvariablen.");
  }

  const body = await readJson(request, 40 * 1024);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > maximumSpeechTextCharacters) {
    throw new HttpError(400, "invalid_speech_text", "Die Antwort muss zwischen 1 und 5.000 Zeichen lang sein.");
  }

  let upstream;
  try {
    upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5", language_code: "de" }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new HttpError(504, "elevenlabs_timeout", "ElevenLabs hat zu lange gebraucht. Bitte versuche es erneut.");
    }
    throw new HttpError(502, "elevenlabs_network", "ElevenLabs ist gerade nicht erreichbar. Bitte versuche es erneut.");
  }

  if (!upstream.ok) {
    if (upstream.status === 401 || upstream.status === 403) throw new HttpError(502, "elevenlabs_key", "Der ElevenLabs-Schlüssel ist ungültig oder für Text-to-Speech nicht freigeschaltet.");
    if (upstream.status === 404 || upstream.status === 422) throw new HttpError(400, "elevenlabs_voice", "Die ElevenLabs Voice-ID ist ungültig oder für dein Konto nicht verfügbar.");
    if (upstream.status === 429) throw new HttpError(429, "elevenlabs_rate_limit", "Das ElevenLabs-Limit ist erreicht. Bitte warte kurz.");
    if (upstream.status === 402) throw new HttpError(402, "elevenlabs_quota", "Dein ElevenLabs-Kontingent ist aufgebraucht. Prüfe dein Konto und den Tarif.");
    throw new HttpError(502, "elevenlabs_provider", "ElevenLabs konnte die Stimme gerade nicht erzeugen.");
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  if (!audio.length || audio.length > 20 * 1024 * 1024) throw new HttpError(502, "elevenlabs_audio", "ElevenLabs hat keine gültige Audiodatei zurückgegeben.");
  response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(audio);
}

async function handleChat(request, response) {
  const body = await readJson(request);
  const mathFormattingInstruction = {
    role: "system",
    content: "Du bist MalikAI, ein hilfreicher Assistent. Antworte in der Sprache des Nutzers. Wenn Mathematik vorkommt, schreibe mathematische Formeln mit LaTeX und setze Inline-Formeln in \\( ... \\), eigenständige Formeln in \\[ ... \\]. Nutze zum Beispiel \\sqrt{x} für Quadratwurzeln, \\sqrt[3]{x} für Kubikwurzeln, x^{2} für Potenzen, x_{1} für Indizes und \\frac{a}{b} für Brüche. Setze jede eigenständige Formel auf eine eigene Zeile und schreibe Formeln nicht in Codeblöcke. Schreibe außerhalb von Formelklammern keine LaTeX-Befehle: verwende im Fließtext Unicode-Zeichen wie π, ≤, ≥, ≠, ∞ und ×.",
  };
  const messages = [mathFormattingInstruction, ...validateChatMessages(body.messages)];
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new HttpError(400, "missing_key", "Trage zuerst GROQ_API_KEY in deiner lokalen .env-Datei ein und starte den Server neu.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const stopIfClosed = () => controller.abort();
  response.once("close", stopIfClosed);

  try {
    let upstream;
    try {
      upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ model: chatModel, messages, stream: true }),
        signal: controller.signal,
      });
    } catch {
      if (response.destroyed) return;
      throw new HttpError(502, "network", "Groq ist nicht erreichbar. Prüfe deine Internetverbindung.");
    }

    if (!upstream.ok) throw chatProviderError(upstream.status);
    if (!upstream.body) throw new HttpError(502, "provider_error", "Groq hat keine Chatantwort zurückgegeben.");

    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    for await (const chunk of upstream.body) {
      if (response.destroyed) break;
      if (!response.write(chunk)) {
        await new Promise((resolveDrain) => {
          const finish = () => {
            response.off("drain", finish);
            response.off("close", finish);
            resolveDrain();
          };
          response.once("drain", finish);
          response.once("close", finish);
        });
      }
    }
    if (!response.destroyed) response.end();
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.write('data: {"error":{"message":"stream_error"}}\n\n');
      response.end();
      return;
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "network", "Die Groq-Antwort wurde unterbrochen. Versuche es bitte erneut.");
  } finally {
    clearTimeout(timeout);
    response.off("close", stopIfClosed);
  }
}

function imageProviderError(status, providerCode) {
  if (status === 401) return new HttpError(401, "invalid_key", "Der OpenAI-Schlüssel ist ungültig. Prüfe deine .env-Datei.");
  if (status === 402 || status === 429 || providerCode === "insufficient_quota" || providerCode === "billing_hard_limit_reached") {
    return new HttpError(429, "quota", "Das OpenAI-Kontingent oder Abrechnungslimit ist erreicht. Prüfe dein OpenAI-Konto.");
  }
  if (status === 403 || providerCode === "organization_verification_required") {
    return new HttpError(403, "account_access", "Dein OpenAI-Konto hat noch keinen Zugriff auf die Bildgenerierung.");
  }
  if (providerCode === "content_policy_violation" || providerCode === "moderation_blocked") {
    return new HttpError(400, "moderation", "Diese Bildanfrage kann wegen der Inhaltsrichtlinien nicht erstellt werden. Ändere den Prompt.");
  }
  return new HttpError(502, "provider_error", "OpenAI konnte das Bild gerade nicht erstellen. Prüfe Kontozugriff und Abrechnung.");
}

async function readImageProviderJson(response) {
  if (!response.body) return null;
  const maximumBytes = response.ok ? maximumImageResponseBytes : 128 * 1024;
  const chunks = [];
  let byteCount = 0;

  for await (const chunk of response.body) {
    byteCount += chunk.length;
    if (byteCount > maximumBytes) {
      if (response.ok) throw new HttpError(502, "malformed_output", "Die OpenAI-Antwort ist größer als das erlaubte Bildlimit.");
      return null;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function isValidPngBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximumImageBytes * 4 / 3) + 4 || !base64Pattern.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.length > pngSignature.length && bytes.length <= maximumImageBytes && bytes.subarray(0, pngSignature.length).equals(pngSignature);
}

async function handleImageGeneration(request, response) {
  const body = await readJson(request, 32 * 1024);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const quality = body.quality;
  if (!prompt || prompt.length > 8_000 || !["low", "medium", "high"].includes(quality)) {
    throw new HttpError(400, "invalid_request", "Gib einen Prompt mit höchstens 8.000 Zeichen und eine gültige Bildqualität an.");
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new HttpError(400, "missing_key", "Trage zuerst OPENAI_API_KEY in deiner lokalen .env-Datei ein und starte den Server neu.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const stopIfClosed = () => controller.abort();
  response.once("close", stopIfClosed);
  let upstream;
  let payload;
  try {
    upstream = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-image-2.5-flare",
        prompt,
        n: 1,
        size: "1024x1024",
        quality,
        output_format: "png",
      }),
      signal: controller.signal,
    });
    payload = await readImageProviderJson(upstream);
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "network", "OpenAI ist nicht erreichbar. Prüfe deine Internetverbindung.");
  } finally {
    clearTimeout(timeout);
    response.off("close", stopIfClosed);
  }

  if (!upstream.ok) {
    const error = payload && typeof payload === "object" ? payload.error : undefined;
    const providerCode = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
    throw imageProviderError(upstream.status, providerCode);
  }

  const image = payload && typeof payload === "object" && Array.isArray(payload.data)
    ? payload.data[0]?.b64_json
    : undefined;
  if (!isValidPngBase64(image)) {
    throw new HttpError(502, "malformed_output", "OpenAI hat kein gültiges PNG-Bild zurückgegeben.");
  }
  sendJson(response, 200, { base64: image, mimeType: "image/png" });
}

async function serveStatic(pathname, response) {
  const mathjaxPrefix = "/mathjax/";
  if (pathname.startsWith(mathjaxPrefix)) {
    const segments = pathname.slice(mathjaxPrefix.length).split("/");
    if (!segments.length || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === "." || segment === "..")) return false;

    const mathjaxDirectory = resolve(projectDirectory, "node_modules", "mathjax");
    const filePath = resolve(mathjaxDirectory, ...segments);
    if (!filePath.startsWith(`${mathjaxDirectory}${sep}`)) return false;

    let content;
    try {
      content = await readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }

    const extension = extname(filePath).toLowerCase();
    const type = extension === ".css"
      ? "text/css; charset=utf-8"
      : extension === ".js" || extension === ".mjs"
        ? "text/javascript; charset=utf-8"
        : extension === ".woff2"
          ? "font/woff2"
          : extension === ".woff"
            ? "font/woff"
            : extension === ".svg"
              ? "image/svg+xml"
              : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type, "Content-Length": content.length });
    response.end(content);
    return true;
  }

  const filename = staticFiles.get(pathname);
  if (!filename) return false;

  const filePath = resolve(projectDirectory, filename);
  const content = await readFile(filePath);
  const type = extname(filename) === ".css"
    ? "text/css; charset=utf-8"
    : extname(filename) === ".js"
      ? "text/javascript; charset=utf-8"
      : "text/html; charset=utf-8";
  response.writeHead(200, { "Content-Type": type, "Content-Length": content.length });
  response.end(content);
  return true;
}

async function handleRequest(request, response) {
  const host = String(request.headers.host || "").toLowerCase();
  if (!host || !allowedHosts.has(host)) throw new HttpError(403, "invalid_host", "Diese Website ist unter dieser Adresse nicht erreichbar.");

  const url = new URL(request.url || "/", publicOrigin || `http://${host}`);
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    sendJson(response, 200, { authenticated: Boolean(authenticatedSession(request)) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    requireSameOriginBrowserRequest(request);
    return await handleLogin(request, response);
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    requireSameOriginBrowserRequest(request);
    return handleLogout(request, response);
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    requireAuthenticatedSession(request);
    sendJson(response, 200, {
      groqConfigured: Boolean(process.env.GROQ_API_KEY?.trim()),
      openAiImageConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
      model: chatModel,
    });
    return;
  }

  if (request.method === "POST" && url.pathname.startsWith("/api/")) {
    requireSameOriginBrowserRequest(request);
    requireAuthenticatedSession(request);
    if (url.pathname === "/api/chat") return await handleChat(request, response);
    if (url.pathname === "/api/voice/transcribe") return await handleVoiceTranscription(request, response);
    if (url.pathname === "/api/voice/speak") return await handleVoiceSpeech(request, response);
    if (url.pathname === "/api/images/generate") return await handleImageGeneration(request, response);
    throw new HttpError(404, "not_found", "Diese lokale API-Adresse wurde nicht gefunden.");
  }

  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed", "Diese Anfrage ist nicht erlaubt.");
  if (await serveStatic(url.pathname, response)) return;
  throw new HttpError(404, "not_found", "Diese Seite wurde nicht gefunden.");
}

const server = createServer((request, response) => {
  setSecurityHeaders(response);
  void handleRequest(request, response).catch((error) => {
    if (response.destroyed || response.headersSent) {
      if (!response.destroyed) response.end();
      return;
    }
    if (error instanceof HttpError) {
      sendJson(response, error.status, { code: error.code, error: error.message });
      return;
    }
    sendJson(response, 500, { code: "server_error", error: "Der lokale Server konnte die Anfrage nicht abschließen." });
  });
});

const listenAddress = publicOrigin ? "0.0.0.0" : "127.0.0.1";
server.listen(port, listenAddress, () => {
  console.log(`MalikAI Web läuft auf ${publicOrigin || `http://127.0.0.1:${port}`}`);
  console.log("Anmeldung und API-Schlüssel werden nur im Serverprozess verwaltet.");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} ist bereits belegt. Ändere PORT in deiner .env-Datei oder Hosting-Konfiguration.`);
  } else {
    console.error("Der lokale Webserver konnte nicht gestartet werden.");
  }
  process.exitCode = 1;
});

