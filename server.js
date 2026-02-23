const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const axios = require("axios");
const https = require("https");
const FormData = require("form-data");

const app = express();

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const STATES = {
  BOT: "bot",
  CONNECTING: "connecting",
  WITH_AGENT: "with_agent",
};

const END_COMMANDS = new Set(["finalizar", "salir"]);
const SUPPORT_WEBHOOK_URL = process.env.SUPPORT_WEBHOOK_URL;

const sessions = {};

console.log(
  "🔑 API KEY CARGADA:",
  JSON.stringify(process.env.GUPSHUP_API_KEY_FINAL),
);
console.log(
  "🔗 URL CARGADA:",
  JSON.stringify(process.env.GUPSHUP_API_URL_FINAL),
);
console.log("📱 SOURCE:", JSON.stringify(process.env.GUPSHUP_SOURCE));
console.log("📛 APP NAME:", JSON.stringify(process.env.GUPSHUP_APP_NAME));

// ─────────────────────────────────────────────────────────────
// OPCIÓN 1: Partner API v3  (body JSON, header Authorization)
// ─────────────────────────────────────────────────────────────
async function sendViaPartnerV3(destination, payload) {
  const apiUrl = process.env.GUPSHUP_API_URL_FINAL || "";
  if (!apiUrl) throw new Error("GUPSHUP_API_URL_FINAL no configurado");

  let tipoMensaje = payload.type || "text";
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: destination,
  };

  if (tipoMensaje === "text") {
    body.type = "text";
    body.text = { body: payload.text || "" };
  } else if (tipoMensaje === "quick_reply") {
    body.type = "interactive";
    body.interactive = {
      type: "button",
      body: {
        text: payload.content?.text || payload.text || "Selecciona una opción",
      },
      action: {
        buttons: (payload.options || []).slice(0, 3).map((opt, index) => ({
          type: "reply",
          reply: {
            id: opt.postbackText || `btn_${index}`,
            title: (opt.title || "Opción").substring(0, 20),
          },
        })),
      },
    };
  } else if (tipoMensaje === "image") {
    body.type = "image";
    body.image = {
      link: payload.originalUrl || payload.url || "",
      caption: payload.caption || "",
    };
  } else if (tipoMensaje === "document") {
    body.type = "document";
    body.document = {
      link: payload.url || "",
      filename: payload.filename || "document",
      caption: payload.caption || "",
    };
  } else if (tipoMensaje === "audio") {
    body.type = "audio";
    body.audio = { link: payload.url || "" };
  } else if (tipoMensaje === "video") {
    body.type = "video";
    body.video = { link: payload.url || "", caption: payload.caption || "" };
  } else {
    body.type = "text";
    body.text = {
      body: payload.text || payload.content?.text || JSON.stringify(payload),
    };
  }

  const headers = {
    apikey: process.env.GUPSHUP_API_KEY_FINAL,
    "Content-Type": "application/json",
  };

  console.log("📤 [Partner v3] Enviando a:", destination);
  const response = await axios.post(apiUrl, body, { headers });
  console.log("✅ [Partner v3] OK:", JSON.stringify(response.data));
  return response.data;
}

// ─────────────────────────────────────────────────────────────
// OPCIÓN 2: Legacy API  (/sm/api/v1/msg, form-urlencoded)
// ─────────────────────────────────────────────────────────────
async function sendViaLegacy(destination, payload) {
  const apiUrl =
    process.env.GUPSHUP_API_URL_LEGACY ||
    "https://api.gupshup.io/sm/api/v1/msg";

  const source = process.env.GUPSHUP_SOURCE;
  const appName = process.env.GUPSHUP_APP_NAME;

  if (!source || !appName) {
    throw new Error(
      "GUPSHUP_SOURCE_NUMBER o GUPSHUP_APP_NAME no configurados para Legacy API",
    );
  }

  let messageObj;
  const tipoMensaje = payload.type || "text";

  if (tipoMensaje === "text") {
    messageObj = { type: "text", text: payload.text || "" };
  } else if (tipoMensaje === "quick_reply") {
    messageObj = {
      type: "quick_reply",
      msgid: payload.msgid || "qr1",
      content: payload.content,
      options: payload.options,
    };
  } else if (tipoMensaje === "image") {
    messageObj = {
      type: "image",
      originalUrl: payload.originalUrl || payload.url || "",
      caption: payload.caption || "",
    };
  } else if (tipoMensaje === "document") {
    messageObj = {
      type: "file",
      url: payload.url || "",
      filename: payload.filename || "document",
    };
  } else if (tipoMensaje === "audio") {
    messageObj = { type: "audio", url: payload.url || "" };
  } else if (tipoMensaje === "video") {
    messageObj = {
      type: "video",
      url: payload.url || "",
      caption: payload.caption || "",
    };
  } else {
    messageObj = {
      type: "text",
      text: payload.text || payload.content?.text || JSON.stringify(payload),
    };
  }

  const form = new URLSearchParams();
  form.append("channel", "whatsapp");
  form.append("source", source);
  form.append("destination", destination);
  form.append("src.name", appName);
  form.append("message", JSON.stringify(messageObj));

  const headers = {
    apikey: process.env.GUPSHUP_API_KEY_FINAL,
    "Content-Type": "application/x-www-form-urlencoded",
  };

  console.log("📤 [Legacy] Enviando a:", destination);
  const response = await axios.post(apiUrl, form.toString(), { headers });
  console.log("✅ [Legacy] OK:", JSON.stringify(response.data));
  return response.data;
}

// ─────────────────────────────────────────────────────────────
// WRAPPER con fallback automático
// Intenta Partner v3 → si falla con 401/4xx, reintenta Legacy
// ─────────────────────────────────────────────────────────────
async function sendGupshupMessage(destination, payload) {
  console.log("\n📨 PAYLOAD ORIGINAL:", JSON.stringify(payload, null, 2));

  try {
    return await sendViaPartnerV3(destination, payload);
  } catch (err) {
    const status = err.response?.status;
    console.warn(
      `⚠️ [Partner v3] falló con status ${status || "sin respuesta"}: ${err.message}`,
    );

    // Solo hacer fallback en errores de autenticación/cliente (4xx)
    // En errores de red también intentamos fallback
    const shouldFallback =
      !status ||
      status === 401 ||
      status === 403 ||
      (status >= 400 && status < 500);

    if (shouldFallback) {
      console.log("🔄 Intentando con Legacy API...");
      try {
        return await sendViaLegacy(destination, payload);
      } catch (legacyErr) {
        console.error(`❌ [Legacy] también falló: ${legacyErr.message}`);
        if (legacyErr.response) {
          console.error("🔎 Legacy status:", legacyErr.response.status);
          console.error(
            "🔎 Legacy data:",
            JSON.stringify(legacyErr.response.data, null, 2),
          );
        }
        throw legacyErr; // Re-lanzar el error del último intento
      }
    } else {
      // Error de servidor (5xx): re-lanzar sin fallback
      if (err.response) {
        console.error("🔎 Partner v3 status:", err.response.status);
        console.error(
          "🔎 Partner v3 data:",
          JSON.stringify(err.response.data, null, 2),
        );
      }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const data = req.body;

  if (data.type === "agent_accepted") {
    const numeroAgente = data.numeroAgente;
    const numeroCliente = data.numeroCliente;

    console.log(`\n${"🟢".repeat(35)}`);
    console.log(`✅ AGENTE ACEPTÓ LA CONVERSACIÓN`);
    console.log(`   • Agente: ${numeroAgente}`);
    console.log(`   • Cliente: ${numeroCliente}`);
    console.log(`${"🟢".repeat(35)}\n`);

    if (!sessions[numeroCliente]) {
      sessions[numeroCliente] = { step: "menu", state: STATES.BOT };
    }

    if (
      sessions[numeroCliente].state === STATES.WITH_AGENT &&
      sessions[numeroCliente].numeroAgente !== numeroAgente
    ) {
      console.warn(`⚠️ Cliente ${numeroCliente} ya está con otro agente`);
      return res.sendStatus(200);
    }

    if (sessions[numeroCliente].timeoutId) {
      clearTimeout(sessions[numeroCliente].timeoutId);
      console.log(`⏰ Timeout cancelado para ${numeroCliente}`);
      delete sessions[numeroCliente].timeoutId;
    }

    sessions[numeroCliente].state = STATES.WITH_AGENT;
    sessions[numeroCliente].numeroAgente = numeroAgente;
    sessions[numeroCliente].connectedAt = Date.now();

    try {
      await sendGupshupMessage(numeroCliente, {
        type: "text",
        text: `✅ *Agente conectado*\n\nAhora estás en conversación privada con el agente.\n\n📱 Escribe tu consulta aquí.`,
      });
    } catch (error) {
      console.error(`❌ Error enviando confirmación:`, error.message);
    }

    return res.sendStatus(200);
  }

  if (data.type === "chat_ended") {
    const numeroCliente = data.numeroCliente || data.from;
    const numeroAgente = data.numeroAgente;

    console.log(`\n${"🔴".repeat(35)}`);
    console.log(`🔚 CHAT FINALIZADO DESDE APLICATIVO`);
    console.log(`   • Cliente: ${numeroCliente}`);
    if (numeroAgente) console.log(`   • Agente: ${numeroAgente}`);
    console.log(`${"🔴".repeat(35)}\n`);

    if (!numeroCliente) return res.sendStatus(200);

    if (!sessions[numeroCliente]) {
      sessions[numeroCliente] = { step: "menu", state: STATES.BOT };
    } else {
      sessions[numeroCliente].state = STATES.BOT;
      sessions[numeroCliente].step = "menu";
      delete sessions[numeroCliente].numeroAgente;
      delete sessions[numeroCliente].connectedAt;
      if (sessions[numeroCliente].timeoutId) {
        clearTimeout(sessions[numeroCliente].timeoutId);
        delete sessions[numeroCliente].timeoutId;
      }
    }

    try {
      await sendGupshupMessage(numeroCliente, {
        type: "text",
        text: "👋 *Conversacion finalizada*\n\n✅ Has vuelto al chatbot automatico.\n\nEscribe *menu* para ver las opciones.",
      });
    } catch (error) {
      console.error("❌ Error enviando mensaje de cierre:", error.message);
    }

    return res.sendStatus(200);
  }

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || !message.from) return res.sendStatus(200);

    const from = message.from;
    let text = "";
    let rawText = "";
    let messageType = "text";

    switch (message.type) {
      case "text":
        rawText = (message.text?.body || "").trim();
        if (
          rawText.startsWith("{") &&
          rawText.includes('"type":"agent_accepted"')
        ) {
          return res.sendStatus(200);
        }
        text = rawText.toLowerCase();
        messageType = "text";
        console.log(`📨 Texto de ${from}: "${text}"`);
        break;
      case "interactive":
        const reply =
          message.interactive.button_reply || message.interactive.list_reply;
        if (reply) {
          try {
            text = JSON.parse(reply.id).postbackText;
          } catch {
            text = reply.id;
          }
        }
        text = (text || "").toLowerCase().trim();
        messageType = "interactive";
        console.log(`🔘 Interactivo de ${from}: "${text}"`);
        break;
      case "image":
        rawText = message.image?.caption || "";
        text = rawText.toLowerCase();
        messageType = "image";
        break;
      case "document":
        rawText = message.document?.caption || message.document?.filename || "";
        text = rawText.toLowerCase();
        messageType = "document";
        break;
      case "audio":
        text = "[Audio]";
        messageType = "audio";
        break;
      case "video":
        rawText = message.video?.caption || "";
        text = rawText.toLowerCase();
        messageType = "video";
        break;
      case "reaction":
        text = message.reaction?.emoji || "";
        messageType = "reaction";
        break;
      default:
        return res.sendStatus(200);
    }

    if (!sessions[from]) {
      sessions[from] = { step: "menu", state: STATES.BOT };
      console.log(`👤 Nueva sesión: ${from}`);
    }

    try {
      const estadoResponse = await axios.get(
        `${SUPPORT_WEBHOOK_URL.replace("/webhook", "")}/cliente-estado/${from}`,
        { timeout: 3000, httpsAgent },
      );
      if (estadoResponse.data.tieneAgente) {
        if (sessions[from].state !== STATES.WITH_AGENT) {
          sessions[from].state = STATES.WITH_AGENT;
          sessions[from].numeroAgente = estadoResponse.data.agente;
        }
      }
    } catch (syncError) {
      console.log(`⚠️ Sync error: ${syncError.message}`);
    }

    console.log(
      `📊 Estado ${from}: ${sessions[from].state} (step: ${sessions[from].step})`,
    );

    if (sessions[from].state === STATES.WITH_AGENT) {
      if (END_COMMANDS.has(text)) {
        const numeroAgente = sessions[from].numeroAgente;
        sessions[from].state = STATES.BOT;
        sessions[from].step = "menu";
        delete sessions[from].numeroAgente;
        delete sessions[from].connectedAt;
        if (sessions[from].timeoutId) {
          clearTimeout(sessions[from].timeoutId);
          delete sessions[from].timeoutId;
        }

        await sendGupshupMessage(from, {
          type: "text",
          text: "👋 *Conversación con agente finalizada*\n\n✅ Has vuelto al chatbot automático.\n\nEscribe *menu* para ver las opciones.",
        });

        try {
          await axios.post(
            SUPPORT_WEBHOOK_URL,
            {
              from,
              numeroAgente,
              type: "chat_ended",
              reason: "user_command",
              timestamp: new Date().toISOString(),
            },
            { timeout: 10000, httpsAgent },
          );
        } catch (e) {
          console.error("❌ Error notificando fin de chat:", e.message);
        }

        return res.sendStatus(200);
      }

      let payloadToSupport = {
        from,
        text: rawText || text || "",
        type: "incoming_message",
        message_type: messageType,
        timestamp: new Date().toISOString(),
        object: "whatsapp_business_account",
        ...(messageType === "image" && {
          mediaUrl: message.image?.id || "",
          url: message.image?.url || "",
          mime_type: message.image?.mime_type || "image/jpeg",
          caption: message.image?.caption || "",
        }),
        ...(messageType === "document" && {
          mediaUrl: message.document?.id || "",
          url: message.document?.url || "",
          mime_type: message.document?.mime_type || "application/octet-stream",
          filename: message.document?.filename || "",
          caption: message.document?.caption || "",
        }),
        ...(messageType === "audio" && {
          mediaUrl: message.audio?.id || "",
          url: message.audio?.url || "",
          mime_type: message.audio?.mime_type || "audio/mpeg",
        }),
        ...(messageType === "video" && {
          mediaUrl: message.video?.id || "",
          url: message.video?.url || "",
          mime_type: message.video?.mime_type || "video/mp4",
          caption: message.video?.caption || "",
        }),
      };

      try {
        await axios.post(SUPPORT_WEBHOOK_URL, payloadToSupport, {
          timeout: 10000,
          httpsAgent,
        });
      } catch (e) {
        console.error("❌ Error reenviando al soporte:", e.message);
      }
      return res.sendStatus(200);
    }

    if (sessions[from].state === STATES.CONNECTING) {
      console.log(`⏳ ${from} esperando agente, mensaje ignorado`);
      return res.sendStatus(200);
    }

    if (text === "menu" || text === "menú") {
      if (sessions[from].timeoutId) {
        clearTimeout(sessions[from].timeoutId);
        delete sessions[from].timeoutId;
      }
      sessions[from].step = "menu";
      sessions[from].state = STATES.BOT;
    }

    let messagePayload = null;

    if (sessions[from].step === "menu") {
      messagePayload = {
        type: "quick_reply",
        msgid: "menu_principal",
        content: {
          type: "text",
          text: "👋 ¡Bienvenido!\n\n¿En qué podemos ayudarte hoy?",
        },
        options: [
          { type: "text", title: "🛠️ Soporte", postbackText: "btn_soporte" },
          { type: "text", title: "💰 Ventas", postbackText: "btn_ventas" },
        ],
      };
      sessions[from].step = "option";
    } else if (sessions[from].step === "option") {
      if (text === "btn_soporte" || text === "soporte") {
        sessions[from].state = STATES.CONNECTING;
        sessions[from].requestTime = Date.now();

        await sendGupshupMessage(from, {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        });

        try {
          await axios.post(
            process.env.SUPPORT_WEBHOOK_URL,
            {
              from,
              text: "soporte",
              tipo: "text",
              type: "support_request",
              message_type: "text",
              object: "whatsapp_business_account",
              timestamp: new Date().toISOString(),
              cola: "LuisPruebas",
              pausa: 2,
            },
            { timeout: 10000, httpsAgent },
          );

          const timeoutId = setTimeout(() => {
            if (sessions[from] && sessions[from].state === STATES.CONNECTING) {
              sessions[from].state = STATES.BOT;
              sessions[from].step = "menu";
              delete sessions[from].timeoutId;
              sendGupshupMessage(from, {
                type: "text",
                text: "⏰ No hay agentes disponibles en este momento.\n\nEscribe *menu* para ver otras opciones.",
              });
            }
          }, 120000);

          sessions[from].timeoutId = timeoutId;
        } catch (error) {
          console.error(`❌ Error enviando solicitud:`, error.message);
          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";
          await sendGupshupMessage(from, {
            type: "text",
            text: "❌ Error al conectar.\n\nEscribe *menu* para intentar nuevamente.",
          });
        }

        return res.sendStatus(200);
      } else if (text === "btn_ventas") {
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nVisita nuestra web: https://tuapp.com/ventas\n\nEscribe *menu* para volver.",
        };
        sessions[from].step = "menu";
      } else {
        messagePayload = {
          type: "text",
          text: "❌ No entendí tu respuesta.\n\nEscribe *menu* para ver las opciones disponibles.",
        };
      }
    }

    if (messagePayload) {
      await sendGupshupMessage(from, messagePayload);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error en Webhook:", err.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Bot Online 🚀"));

const PORT = process.env.CHATBOT_PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Bot servidor en puerto ${PORT}`));
