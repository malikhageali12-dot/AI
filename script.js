const app = document.querySelector("#app");
const authGate = document.querySelector("#authGate");
const authForm = document.querySelector("#authForm");
const authPassword = document.querySelector("#authPassword");
const authFeedback = document.querySelector("#authFeedback");
const authSubmit = document.querySelector("#authSubmit");
const sidebar = document.querySelector("#sidebar");
const mobileScrim = document.querySelector("#mobileScrim");
const chatView = document.querySelector("#chatView");
const imageView = document.querySelector("#imageView");
const chatComposer = document.querySelector("#chatComposer");
const welcomePanel = document.querySelector("#welcomePanel");
const messagesElement = document.querySelector("#messages");
const chatFeedback = document.querySelector("#chatFeedback");
const imageFeedback = document.querySelector("#imageFeedback");
const conversationList = document.querySelector("#conversationList");
const conversationSearch = document.querySelector("#conversationSearch");
const chatInput = document.querySelector("#chatInput");
const chatForm = document.querySelector("#chatForm");
const sendButton = document.querySelector("#sendButton");
const stopButton = document.querySelector("#stopButton");
const voiceStatus = document.querySelector("#voiceStatus");
const voiceButton = document.querySelector("#voiceButton");
const voiceInputDevice = document.querySelector("#voiceInputDevice");
const imageForm = document.querySelector("#imageForm");
const imagePrompt = document.querySelector("#imagePrompt");
const imageQuality = document.querySelector("#imageQuality");
const imageResult = document.querySelector("#imageResult");
const generatedImage = document.querySelector("#generatedImage");
const previewPlaceholder = document.querySelector("#previewPlaceholder");
const generatingOverlay = document.querySelector("#generatingOverlay");
const saveImageButton = document.querySelector("#saveImage");
const settingsDialog = document.querySelector("#settingsDialog");

const conversationStorageKey = "malikai.web.conversations.v1";
const themeStorageKey = "malikai.web.theme";
const previousConversationStorageKey = "lumen.web.conversations.v1";
const previousThemeStorageKey = "lumen.web.theme";
const plainMathSymbols = {
  alpha: "α", beta: "β", theta: "θ", lambda: "λ", mu: "μ", sigma: "σ", omega: "ω",
  Delta: "Δ", Sigma: "Σ", pi: "π", times: "×", cdot: "·", div: "÷", pm: "±",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", approx: "≈", infty: "∞",
  int: "∫", sum: "∑", prod: "∏", sqrt: "√",
};
let mathTypesetQueue = Promise.resolve();

const state = {
  conversations: loadConversations(),
  activeId: null,
  view: "chat",
  streamController: null,
  imageBase64: "",
  imagePromptText: "",
  theme: readTheme(),
  status: null,
  imageBusy: false,
  voiceMode: "idle",
};

const voiceState = {
  recorder: null,
  stream: null,
  chunks: [],
  timer: null,
  limitTimer: null,
  selectedDeviceId: localStorage.getItem("malikai.voice.device") || "",
};

function readTheme() {
  try {
    const storedTheme = localStorage.getItem(themeStorageKey) ?? localStorage.getItem(previousThemeStorageKey);
    if (localStorage.getItem(themeStorageKey) === null && storedTheme !== null) {
      localStorage.setItem(themeStorageKey, storedTheme);
    }
    return storedTheme === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

function makeId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `malikai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadConversations() {
  try {
    const currentData = localStorage.getItem(conversationStorageKey);
    const previousData = currentData === null ? localStorage.getItem(previousConversationStorageKey) : null;
    const storedData = currentData ?? previousData ?? "[]";
    if (currentData === null && previousData !== null) localStorage.setItem(conversationStorageKey, previousData);
    const stored = JSON.parse(storedData);
    if (!Array.isArray(stored)) return [];
    return stored.filter((conversation) =>
      conversation && typeof conversation.id === "string" && typeof conversation.title === "string" && Array.isArray(conversation.messages),
    ).map((conversation) => ({
      id: conversation.id,
      title: conversation.title.slice(0, 100),
      updatedAt: Number(conversation.updatedAt) || Date.now(),
      messages: conversation.messages.filter((message) =>
        message && ["user", "assistant"].includes(message.role) && typeof message.content === "string",
      ).map((message) => ({ role: message.role, content: message.content.slice(0, 8_000) })),
    }));
  } catch {
    return [];
  }
}

function saveConversations() {
  try {
    localStorage.setItem(conversationStorageKey, JSON.stringify(state.conversations));
  } catch {
    showChatFeedback("Der Browser kann den Gesprächsverlauf nicht speichern. Prüfe deinen verfügbaren Speicherplatz.");
  }
}

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId) || null;
}

function setFeedback(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function showChatFeedback(message) {
  setFeedback(chatFeedback, message);
}

function showImageFeedback(message) {
  setFeedback(imageFeedback, message);
}

function showAuthGate(message = "") {
  if (state.streamController) state.streamController.abort();
  if (settingsDialog.open) settingsDialog.close();
  app.hidden = true;
  authGate.hidden = false;
  authPassword.value = "";
  setFeedback(authFeedback, message);
  authPassword.focus();
}

function showApp() {
  authGate.hidden = true;
  app.hidden = false;
  applyTheme();
  render();
}

async function initializeAccess() {
  try {
    const response = await fetch("/api/auth/session", { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Verbindung zum Website-Server fehlgeschlagen.");
    const session = await response.json();
    if (!session.authenticated) {
      showAuthGate();
      return;
    }
    showApp();
    await refreshServerStatus();
  } catch {
    showAuthGate("Der Website-Server ist gerade nicht erreichbar. Bitte lade die Seite später erneut.");
  }
}

async function signOut() {
  let message = "";
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (!response.ok) message = "Der Server konnte die Abmeldung nicht bestätigen. Bitte lade die Seite neu.";
  } catch {
    message = "Die Verbindung zum Server ist unterbrochen. Bitte lade die Seite neu.";
  }
  showAuthGate(message);
}

function applyTheme() {
  app.dataset.theme = state.theme;
  const label = state.theme === "dark" ? "Helles Design" : "Dunkles Design";
  const icon = state.theme === "dark" ? "☼" : "◐";
  document.querySelector("#themeLabel").textContent = label;
  document.querySelector("#themeIcon").textContent = icon;
  document.querySelector("#themeToggleTop").textContent = icon;
  document.querySelector("#themeToggleTop").setAttribute("aria-label", `${label} aktivieren`);
  try {
    localStorage.setItem(themeStorageKey, state.theme);
  } catch {
    // Das Design bleibt für diese Sitzung aktiv, auch wenn der Browser nichts speichern darf.
  }
}

function renderConversationList() {
  const query = conversationSearch.value.trim().toLocaleLowerCase("de-DE");
  const conversations = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  document.querySelector("#conversationCount").textContent = String(state.conversations.length);
  conversationList.replaceChildren();

  const visible = conversations.filter((conversation) => conversation.title.toLocaleLowerCase("de-DE").includes(query));
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = query ? "Keine passenden Gespräche gefunden." : "Deine neuen Gespräche erscheinen hier.";
    conversationList.append(empty);
    return;
  }

  for (const conversation of visible) {
    const row = document.createElement("div");
    row.className = `conversation-row${conversation.id === state.activeId ? " is-active" : ""}`;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "conversation-title";
    open.textContent = conversation.title || "Neuer Chat";
    open.title = conversation.title;
    open.addEventListener("click", () => {
      state.activeId = conversation.id;
      state.view = "chat";
      showChatFeedback("");
      closeMobileMenu();
      render();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "conversation-delete";
    remove.textContent = "×";
    remove.title = "Gespräch löschen";
    remove.setAttribute("aria-label", `Gespräch „${conversation.title}" löschen`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      state.conversations = state.conversations.filter((item) => item.id !== conversation.id);
      if (state.activeId === conversation.id) state.activeId = null;
      saveConversations();
      render();
    });

    row.append(open, remove);
    conversationList.append(row);
  }
}

function renderMessages() {
  const conversation = activeConversation();
  const messages = conversation?.messages || [];
  welcomePanel.hidden = messages.length > 0;
  window.MathJax?.typesetClear?.([messagesElement]);
  messagesElement.replaceChildren();

  for (const message of messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = message.role === "user" ? "Du" : "L";

    const body = document.createElement("div");
    body.className = "message-body";
    const label = document.createElement("p");
    label.className = "message-label";
    label.textContent = message.role === "user" ? "Du" : "MalikAI";
    body.append(label);

    if (message.role === "assistant" && !message.content && state.streamController) {
      const dots = document.createElement("span");
      dots.className = "typing-dots";
      dots.setAttribute("aria-label", "MalikAI schreibt");
      for (let index = 0; index < 3; index += 1) dots.append(document.createElement("i"));
      body.append(dots);
    } else {
      const text = document.createElement(message.role === "assistant" ? "div" : "p");
      text.className = message.role === "assistant" ? "message-text markdown-content" : "message-text";
      if (message.role === "assistant") renderMarkdown(text, message.content);
      else text.textContent = message.content;
      body.append(text);
    }
    article.append(avatar, body);
    messagesElement.append(article);
  }

  if (state.streamController) messagesElement.scrollTop = messagesElement.scrollHeight;
  else typesetMathInMessages();
}

function typesetMathInMessages() {
  if (!window.MathJax?.typesetPromise) return;
  mathTypesetQueue = mathTypesetQueue
    .then(() => window.MathJax?.typesetPromise?.([messagesElement]))
    .catch(() => {});
}

function appendInlineMarkdown(parent, source) {
  const parts = source.split(/(\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g);
  for (const part of parts) {
    if (!part) continue;
    if ((part.startsWith("\\(") && part.endsWith("\\)")) || (part.startsWith("\\[") && part.endsWith("\\]"))) {
      const display = part.startsWith("\\[");
      const math = document.createElement("span");
      math.className = display ? "math-display" : "math-inline";
      math.textContent = part;
      parent.append(math);
    } else if (part.startsWith("`") && part.endsWith("`")) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else if (part.startsWith("**") && part.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      parent.append(strong);
    } else if ((part.startsWith("*") && part.endsWith("*")) || (part.startsWith("_") && part.endsWith("_"))) {
      const emphasis = document.createElement("em");
      emphasis.textContent = part.slice(1, -1);
      parent.append(emphasis);
    } else {
      parent.append(document.createTextNode(renderPlainMathSymbols(part)));
    }
  }
}

function renderPlainMathSymbols(source) {
  return source
    .replace(/\\sqrt\[3\]\{([^{}]*)\}/g, "∛($1)")
    .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
    .replace(/\\([A-Za-z]+)\b/g, (match, command) => plainMathSymbols[command] || match);
}

function renderMarkdown(container, source) {
  const lines = source.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([A-Za-z0-9_+#.-]*)\s*$/);
    if (fence) {
      const language = fence[1];
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const block = document.createElement("div");
      block.className = "markdown-code-block";
      if (language) {
        const languageLabel = document.createElement("span");
        languageLabel.className = "markdown-code-language";
        languageLabel.textContent = language;
        block.append(languageLabel);
      }
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      block.append(pre);
      container.append(block);
      continue;
    }

    const displayMathStart = line.match(/^\s*\\\[(.*)$/);
    if (displayMathStart) {
      const closingDelimiter = /\\\]\s*$/;
      const sameLineClose = displayMathStart[1].match(/^(.*?)\\\]\s*$/);
      let formulaLines = sameLineClose ? [sameLineClose[1]] : null;
      let closingIndex = index;

      if (!formulaLines) {
        for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
          if (closingDelimiter.test(lines[candidate])) {
            closingIndex = candidate;
            break;
          }
        }
        if (closingIndex > index) {
          formulaLines = [displayMathStart[1], ...lines.slice(index + 1, closingIndex), lines[closingIndex].replace(closingDelimiter, "")];
        }
      }

      if (formulaLines) {
        const formula = document.createElement("div");
        formula.className = "math-display";
        formula.textContent = `\\[${formulaLines.join("\n")}\\]`;
        container.append(formula);
        index = sameLineClose ? index + 1 : closingIndex + 1;
        continue;
      }
    }

    const heading = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(element, heading[2]);
      container.append(element);
      index += 1;
      continue;
    }

    const isOrdered = /^\s*\d+[.)]\s+/.test(line);
    const isUnordered = /^\s*[-*+]\s+/.test(line);
    if (isOrdered || isUnordered) {
      const list = document.createElement(isOrdered ? "ol" : "ul");
      while (index < lines.length) {
        const itemMatch = isOrdered
          ? lines[index].match(/^\s*\d+[.)]\s+(.+)$/)
          : lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!itemMatch) break;
        const item = document.createElement("li");
        appendInlineMarkdown(item, itemMatch[1]);
        list.append(item);
        index += 1;
      }
      container.append(list);
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length && lines[index].trim() && !/^\s*```[A-Za-z0-9_+#.-]*\s*$/.test(lines[index]) && !/^\s*#{1,3}\s+/.test(lines[index]) && !/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    const paragraph = document.createElement("p");
    paragraphLines.forEach((paragraphLine, lineIndex) => {
      if (lineIndex > 0) paragraph.append(document.createElement("br"));
      appendInlineMarkdown(paragraph, paragraphLine);
    });
    container.append(paragraph);
  }
}

function render() {
  const isImages = state.view === "images";
  chatView.hidden = isImages;
  imageView.hidden = !isImages;
  chatComposer.hidden = isImages;
  document.querySelector("#chatNav").classList.toggle("is-active", !isImages);
  document.querySelector("#imagesNav").classList.toggle("is-active", isImages);
  document.querySelector("#pageTitle").textContent = isImages ? "Bildwerkstatt" : (activeConversation()?.title || "MalikAI");
  document.querySelector("#modelPill").hidden = isImages;
  renderConversationList();
  renderMessages();
}

function closeMobileMenu() {
  sidebar.classList.remove("is-open");
  mobileScrim.hidden = true;
}

function openSettings() {
  refreshServerStatus();
  if (!settingsDialog.open) settingsDialog.showModal();
}

async function refreshServerStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (response.status === 401) {
      showAuthGate("Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.");
      return;
    }
    if (!response.ok) throw new Error("status");
    const status = await response.json();
    state.status = status;
    updateProviderStatus();
  } catch {
    state.status = null;
    const summary = document.querySelector("#providerSummary");
    summary.replaceChildren();
    const light = document.createElement("span");
    light.className = "provider-light partial";
    light.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "Website-Server nicht erreichbar";
    summary.append(light, text);
    document.querySelector("#groqStatus").textContent = "Website-Server nicht erreichbar";
    document.querySelector("#openAiStatus").textContent = "Website-Server nicht erreichbar";
    document.querySelector("#configuredModel").textContent = "Modell: —";
  }
}

function updateProviderStatus() {
  if (!state.status) return;
  const { groqConfigured, openAiImageConfigured, model } = state.status;
  const summary = document.querySelector("#providerSummary");
  summary.replaceChildren();
  const light = document.createElement("span");
  light.className = `provider-light${groqConfigured && openAiImageConfigured ? " ready" : " partial"}`;
  light.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.textContent = groqConfigured && openAiImageConfigured
    ? "Groq & OpenAI eingerichtet"
    : groqConfigured
      ? "Groq bereit · OpenAI-Key fehlt"
      : openAiImageConfigured
        ? "OpenAI bereit · Groq-Key fehlt"
        : "API-Schlüssel einrichten";
  summary.append(light, text);

  document.querySelector("#groqStatus").textContent = groqConfigured ? "Schlüssel auf dem Server eingerichtet" : "Schlüssel fehlt in der Server-Konfiguration";
  document.querySelector("#openAiStatus").textContent = openAiImageConfigured ? "Schlüssel auf dem Server eingerichtet" : "Schlüssel fehlt in der Server-Konfiguration";
  document.querySelector("#groqIndicator").className = `credential-indicator ${groqConfigured ? "ready" : "missing"}`;
  document.querySelector("#openAiIndicator").className = `credential-indicator ${openAiImageConfigured ? "ready" : "missing"}`;
  document.querySelector("#configuredModel").textContent = `Groq-Modell: ${model || "—"}`;
}

function setChatBusy(busy) {
  chatInput.disabled = busy;
  sendButton.hidden = busy;
  stopButton.hidden = !busy;
  voiceButton.disabled = busy || state.voiceMode === "transcribing";
  voiceInputDevice.disabled = busy || state.voiceMode !== "idle";
}

function setVoiceStatus(mode, message = "") {
  state.voiceMode = mode;
  voiceStatus.textContent = message;
  voiceStatus.hidden = !message;
  voiceStatus.dataset.state = mode;
  voiceButton.classList.toggle("is-recording", mode === "recording");
  voiceButton.classList.toggle("is-busy", mode === "transcribing");
  voiceButton.setAttribute("aria-pressed", String(mode === "recording"));
  voiceButton.setAttribute("aria-label", mode === "recording" ? "Aufnahme beenden und senden" : "Mit MalikAI sprechen");
  voiceButton.title = mode === "recording" ? "Aufnahme beenden und senden" : "Sprachfrage aufnehmen";
  voiceButton.disabled = Boolean(state.streamController) || mode === "starting" || mode === "transcribing";
  voiceInputDevice.disabled = Boolean(state.streamController) || mode !== "idle";
}

async function refreshVoiceDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let inputs = [];
  try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput"); }
  catch { return; }
  const selected = voiceState.selectedDeviceId;
  voiceInputDevice.replaceChildren(new Option("Standardmikrofon", ""));
  inputs.forEach((device, index) => {
    const name = device.label || `Mikrofon ${index + 1}`;
    voiceInputDevice.append(new Option(name, device.deviceId));
  });
  if (selected && inputs.some((device) => device.deviceId === selected)) {
    voiceInputDevice.value = selected;
  } else if (selected) {
    voiceState.selectedDeviceId = "";
    voiceInputDevice.value = "";
    localStorage.removeItem("malikai.voice.device");
  }
}

function stopVoiceTracks() {
  clearInterval(voiceState.timer);
  clearTimeout(voiceState.limitTimer);
  voiceState.timer = null;
  voiceState.limitTimer = null;
  voiceState.stream?.getTracks().forEach((track) => track.stop());
  voiceState.stream = null;
}

function speechTextForReply(markdown) {
  const slash = String.fromCharCode(92);
  const tick = String.fromCharCode(96);
  const parts = String(markdown).split(tick.repeat(3));
  let text = parts.filter((_part, index) => index % 2 === 0).join(" Codeblock ausgelassen. ");
  text = text
    .replaceAll(slash + "sqrt[3]", "Kubikwurzel aus ")
    .replaceAll(slash + "sqrt", "Wurzel aus ")
    .replaceAll(slash + "frac", " geteilt durch ")
    .replaceAll(slash + "times", " mal ")
    .replaceAll(slash + "cdot", " mal ")
    .replaceAll(slash + "leq", " kleiner oder gleich ")
    .replaceAll(slash + "geq", " größer oder gleich ")
    .replaceAll(slash + "neq", " ungleich ")
    .replaceAll(slash + "pi", " Pi ")
    .replaceAll(slash + "infty", " unendlich ")
    .replaceAll(slash + "[", " ").replaceAll(slash + "]", " ")
    .replaceAll(slash + "(", " ").replaceAll(slash + ")", " ")
    .replaceAll(slash, " ").replaceAll("{", " ").replaceAll("}", " ")
    .replaceAll("^", " hoch ").replaceAll("_", " Index ")
    .replaceAll(tick, "").replaceAll("#", " ").replaceAll("*", "")
    .replaceAll(">", " ").replaceAll("$", " ");
  for (const character of [String.fromCharCode(10), String.fromCharCode(13), String.fromCharCode(9)]) {
    text = text.replaceAll(character, " ");
  }
  return text.split(" ").filter(Boolean).join(" ");
}

function speakVoiceReply(markdown) {
  const text = speechTextForReply(markdown);
  if (!text || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
    setVoiceStatus("idle", text ? "Die Audioausgabe wird von diesem Browser nicht unterstützt." : "");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const germanVoice = window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith("de"));
  utterance.lang = germanVoice?.lang || "de-DE";
  if (germanVoice) utterance.voice = germanVoice;
  utterance.onstart = () => setVoiceStatus("speaking", "MalikAI antwortet über dein Standard-Audiogerät …");
  utterance.onend = () => setVoiceStatus("idle");
  utterance.onerror = () => setVoiceStatus("idle", "Die Antwort konnte nicht vorgelesen werden.");
  window.speechSynthesis.speak(utterance);
}

async function toggleVoiceRecording() {
  if (state.voiceMode === "recording") {
    voiceState.recorder?.stop();
    return;
  }
  if (state.voiceMode === "speaking") {
    window.speechSynthesis?.cancel();
    setVoiceStatus("idle");
  }
  if (state.voiceMode !== "idle" || state.streamController) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setVoiceStatus("idle", "Dieser Browser unterstützt keine Mikrofonaufnahme. Öffne MalikAI in Chrome oder Edge.");
    return;
  }

  window.speechSynthesis?.cancel();
  setVoiceStatus("starting", "Mikrofon wird geöffnet …");
  try {
    const constraints = { audio: {
      ...(voiceState.selectedDeviceId ? { deviceId: { exact: voiceState.selectedDeviceId } } : {}),
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } };
    voiceState.stream = await navigator.mediaDevices.getUserMedia(constraints);
    await refreshVoiceDevices();
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"]
      .find((type) => MediaRecorder.isTypeSupported(type));
    voiceState.recorder = new MediaRecorder(voiceState.stream, mimeType ? { mimeType } : undefined);
    voiceState.chunks = [];
    voiceState.recorder.addEventListener("dataavailable", (event) => { if (event.data.size) voiceState.chunks.push(event.data); });
    voiceState.recorder.addEventListener("error", () => {
      stopVoiceTracks();
      setVoiceStatus("idle", "Die Mikrofonaufnahme ist fehlgeschlagen. Prüfe das ausgewählte Headset.");
    }, { once: true });
    voiceState.recorder.addEventListener("stop", () => { void finishVoiceRecording(); }, { once: true });
    voiceState.recorder.start(250);
    let seconds = 0;
    const updateRecordingStatus = () => {
      voiceStatus.textContent = `Aufnahme läuft · ${seconds}s · erneut tippen zum Senden`;
      seconds += 1;
    };
    updateRecordingStatus();
    voiceState.timer = setInterval(updateRecordingStatus, 1000);
    voiceState.limitTimer = setTimeout(() => voiceState.recorder?.stop(), 120_000);
    setVoiceStatus("recording", voiceStatus.textContent);
  } catch (error) {
    stopVoiceTracks();
    const denied = error instanceof DOMException && error.name === "NotAllowedError";
    const missing = error instanceof DOMException && ["NotFoundError", "OverconstrainedError"].includes(error.name);
    setVoiceStatus("idle", denied
      ? "Mikrofonzugriff verweigert. Erlaube MalikAI den Mikrofonzugriff in den Browser- oder Windows-Einstellungen."
      : missing
        ? "Das ausgewählte Mikrofon ist nicht verfügbar. Wähle ein anderes Headset-Mikrofon."
        : "Das Mikrofon konnte nicht geöffnet werden. Prüfe die Berechtigung und versuche es erneut.");
    await refreshVoiceDevices();
  }
}

async function finishVoiceRecording() {
  const recorder = voiceState.recorder;
  const chunks = voiceState.chunks;
  voiceState.recorder = null;
  voiceState.chunks = [];
  stopVoiceTracks();
  const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
  if (blob.size < 256) {
    setVoiceStatus("idle", "Ich habe nichts Verständliches gehört. Bitte sprich näher am Mikrofon.");
    return;
  }
  if (blob.size > 20 * 1024 * 1024) {
    setVoiceStatus("idle", "Die Aufnahme war zu groß. Bitte sprich kürzer und versuche es erneut.");
    return;
  }

  setVoiceStatus("transcribing", "Sprache wird erkannt …");
  try {
    const response = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type || "audio/webm" },
      credentials: "same-origin",
      body: blob,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showAuthGate("Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.");
      throw new Error(payload.error || `Spracherkennung fehlgeschlagen (${response.status}).`);
    }
    const transcript = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!transcript) throw new Error("Ich habe keine Sprache erkannt. Bitte sprich näher am Mikrofon.");
    if (transcript.length > 8000) throw new Error("Das Transkript ist zu lang. Bitte nimm eine kürzere Frage auf.");
    setVoiceStatus("idle", "MalikAI antwortet …");
    const completed = await sendChatMessage(transcript, { speakResponse: true });
    if (!completed) setVoiceStatus("idle");
  } catch (error) {
    setVoiceStatus("idle", error instanceof Error ? error.message : "Die Spracheingabe ist fehlgeschlagen.");
  }
}

voiceButton.addEventListener("click", () => void toggleVoiceRecording());
voiceInputDevice.addEventListener("change", () => {
  voiceState.selectedDeviceId = voiceInputDevice.value;
  if (voiceState.selectedDeviceId) localStorage.setItem("malikai.voice.device", voiceState.selectedDeviceId);
  else localStorage.removeItem("malikai.voice.device");
});
navigator.mediaDevices?.addEventListener?.("devicechange", () => void refreshVoiceDevices());
window.addEventListener("beforeunload", () => {
  if (voiceState.recorder?.state === "recording") voiceState.recorder.stop();
  stopVoiceTracks();
  window.speechSynthesis?.cancel();
});
void refreshVoiceDevices();

function messagesForRequest(messages) {
  const selected = [];
  let total = 0;
  for (const message of [...messages].reverse().slice(0, 80)) {
    const content = message.content.slice(0, 8_000);
    if (total + content.length > 48_000) break;
    selected.unshift({ role: message.role, content });
    total += content.length;
  }
  return selected;
}

async function sendChatMessage(content, { speakResponse = false } = {}) {
  const text = content.trim();
  if (!text || state.streamController) return false;
  showChatFeedback("");

  let conversation = activeConversation();
  if (!conversation) {
    conversation = { id: makeId(), title: text.slice(0, 52), updatedAt: Date.now(), messages: [] };
    state.conversations.unshift(conversation);
    state.activeId = conversation.id;
  }
  if (conversation.messages.length === 0) conversation.title = text.slice(0, 52);
  conversation.messages.push({ role: "user", content: text });
  conversation.updatedAt = Date.now();
  chatInput.value = "";
  resizeTextarea(chatInput);
  saveConversations();

  const assistantMessage = { role: "assistant", content: "" };
  conversation.messages.push(assistantMessage);
  const controller = new AbortController();
  state.streamController = controller;
  setChatBusy(true);
  render();
  let streamReader = null;
  let responseCompleted = false;

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ messages: messagesForRequest(conversation.messages.slice(0, -1)) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) showAuthGate("Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.");
      throw new Error(payload.error || `Chat fehlgeschlagen (${response.status}).`);
    }
    if (!response.body) throw new Error("Der Browser konnte den Antwortstream nicht öffnen.");

    streamReader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let frameData = [];
    let doneFromProvider = false;

    const consumeFrame = () => {
      if (frameData.length === 0) return;
      const data = frameData.join("\n");
      frameData = [];
      if (data === "[DONE]") {
        doneFromProvider = true;
        return;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error("Die Chatantwort hat ein ungültiges Format.");
      }
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        assistantMessage.content += delta;
        renderMessages();
      }
      const providerError = payload.error?.message;
      if (typeof providerError === "string") throw new Error("Groq konnte die Antwort nicht fortsetzen.");
    };

    while (!doneFromProvider) {
      const { value, done } = await streamReader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line === "") consumeFrame();
        else if (line.startsWith("data:")) frameData.push(line.slice(5).trimStart());
        if (doneFromProvider) break;
      }
      if (done) {
        if (buffer.startsWith("data:")) frameData.push(buffer.slice(5).trimStart());
        consumeFrame();
        break;
      }
    }
    if (doneFromProvider) await streamReader.cancel().catch(() => {});
    responseCompleted = doneFromProvider && Boolean(assistantMessage.content.trim());

    conversation.updatedAt = Date.now();
    saveConversations();
  } catch (error) {
    if (streamReader) await streamReader.cancel().catch(() => {});
    if (error?.name === "AbortError") {
      if (!assistantMessage.content) conversation.messages.pop();
      showChatFeedback("Antwort gestoppt.");
    } else {
      if (!assistantMessage.content) conversation.messages.pop();
      showChatFeedback(error instanceof Error ? error.message : "Die Chatantwort konnte nicht geladen werden.");
    }
    saveConversations();
  } finally {
    if (streamReader) streamReader.releaseLock();
    state.streamController = null;
    setChatBusy(false);
    render();
    chatInput.focus();
  }
  if (speakResponse && responseCompleted) speakVoiceReply(assistantMessage.content);
  return responseCompleted;
}

function setImageBusy(busy) {
  state.imageBusy = busy;
  document.querySelector("#generateImage").disabled = busy;
  generatingOverlay.hidden = !busy;
  if (busy && !state.imageBase64) previewPlaceholder.hidden = true;
  if (!busy && !state.imageBase64) previewPlaceholder.hidden = false;
}

async function generateImage(prompt, quality) {
  const response = await fetch("/api/images/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ prompt, quality }),
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) showAuthGate("Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.");
  if (!response.ok) throw new Error(payload.error || `Bildgenerierung fehlgeschlagen (${response.status}).`);
  if (payload.mimeType !== "image/png" || typeof payload.base64 !== "string" || !payload.base64.startsWith("iVBORw0KGgo")) {
    throw new Error("OpenAI hat kein gültiges PNG-Bild zurückgegeben.");
  }
  return payload.base64;
}

async function handleImageSubmit(event) {
  event.preventDefault();
  if (state.imageBusy) return;
  const prompt = imagePrompt.value.trim();
  if (!prompt) {
    showImageFeedback("Beschreibe zuerst dein Bild.");
    imagePrompt.focus();
    return;
  }
  if (!window.confirm("Die Bildgenerierung läuft über die OpenAI API und kann Kosten verursachen. Möchtest du diese Bildanfrage jetzt senden?")) return;

  showImageFeedback("");
  imageResult.hidden = false;
  setImageBusy(true);
  try {
    const base64 = await generateImage(prompt, imageQuality.value);
    state.imageBase64 = base64;
    state.imagePromptText = prompt;
    generatedImage.src = `data:image/png;base64,${base64}`;
    generatedImage.alt = `Generiertes Bild: ${prompt.slice(0, 180)}`;
    generatedImage.hidden = false;
    previewPlaceholder.hidden = true;
    document.querySelector("#imagePromptCaption").textContent = prompt;
    saveImageButton.disabled = false;
    showImageFeedback("");
  } catch (error) {
    showImageFeedback(error instanceof Error ? error.message : "Das Bild konnte nicht erstellt werden.");
  } finally {
    setImageBusy(false);
  }
}

function saveGeneratedImage() {
  if (!state.imageBase64) return;
  try {
    const binary = atob(state.imageBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `malikai-bild-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2_000);
  } catch {
    showImageFeedback("Das Bild konnte nicht gespeichert werden. Versuche es bitte erneut.");
  }
}

function resizeTextarea(textarea) {
  const visualLines = textarea.value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 72)), 0);
  textarea.rows = Math.min(Math.max(visualLines, 1), 7);
}

document.querySelector("#newChat").addEventListener("click", () => {
  if (state.streamController) state.streamController.abort();
  state.activeId = null;
  state.view = "chat";
  chatInput.value = "";
  showChatFeedback("");
  closeMobileMenu();
  render();
  chatInput.focus();
});

document.querySelector("#chatNav").addEventListener("click", () => {
  state.view = "chat";
  closeMobileMenu();
  render();
});

document.querySelector("#imagesNav").addEventListener("click", () => {
  state.view = "images";
  closeMobileMenu();
  render();
  imagePrompt.focus();
});

document.querySelector("#imageSuggestion").addEventListener("click", () => {
  state.view = "images";
  render();
  imagePrompt.focus();
});

for (const suggestion of document.querySelectorAll("[data-prompt]")) {
  suggestion.addEventListener("click", () => {
    state.view = "chat";
    render();
    chatInput.value = suggestion.dataset.prompt || "";
    resizeTextarea(chatInput);
    chatInput.focus();
  });
}

document.querySelector("#menuToggle").addEventListener("click", () => {
  sidebar.classList.add("is-open");
  mobileScrim.hidden = false;
});
document.querySelector("#sidebarClose").addEventListener("click", closeMobileMenu);
mobileScrim.addEventListener("click", closeMobileMenu);

document.querySelector("#settingsOpen").addEventListener("click", () => {
  openSettings();
  closeMobileMenu();
});
document.querySelector("#logoutButton").addEventListener("click", () => void signOut());
document.querySelector("#settingsClose").addEventListener("click", () => settingsDialog.close());
document.querySelector("#settingsDone").addEventListener("click", () => settingsDialog.close());
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) settingsDialog.close();
});

const toggleTheme = () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  applyTheme();
};
document.querySelector("#themeToggle").addEventListener("click", toggleTheme);
document.querySelector("#themeToggleTop").addEventListener("click", toggleTheme);

conversationSearch.addEventListener("input", renderConversationList);
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = authPassword.value;
  if (!password) {
    setFeedback(authFeedback, "Bitte gib das Zugangspasswort ein.");
    authPassword.focus();
    return;
  }

  authPassword.value = "";
  setFeedback(authFeedback, "");
  authSubmit.disabled = true;
  authSubmit.querySelector("span:first-child").textContent = "Zugang wird geprüft …";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ password }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.authenticated) throw new Error(result.error || "Die Anmeldung ist fehlgeschlagen.");
    showApp();
    await refreshServerStatus();
    chatInput.focus();
  } catch (error) {
    setFeedback(authFeedback, error instanceof Error ? error.message : "Die Anmeldung ist fehlgeschlagen.");
    authPassword.focus();
  } finally {
    authSubmit.disabled = false;
    authSubmit.querySelector("span:first-child").textContent = "Website öffnen";
  }
});
authPassword.addEventListener("input", () => setFeedback(authFeedback, ""));
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void sendChatMessage(chatInput.value);
});
chatInput.addEventListener("input", () => resizeTextarea(chatInput));
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});
stopButton.addEventListener("click", () => state.streamController?.abort());

imageForm.addEventListener("submit", (event) => void handleImageSubmit(event));
imagePrompt.addEventListener("input", () => {
  document.querySelector("#promptCount").textContent = `${imagePrompt.value.length.toLocaleString("de-DE")} / 8.000`;
});
saveImageButton.addEventListener("click", saveGeneratedImage);

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    state.activeId = null;
    state.view = "chat";
    render();
    chatInput.focus();
  }
  if (event.key === "Escape") closeMobileMenu();
});

applyTheme();
void initializeAccess();

