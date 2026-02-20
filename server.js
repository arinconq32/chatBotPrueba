const path = require("path");
// require("dotenv").config({ path: path.join(__dirname, "../.env") });
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const axios = require("axios");
const https = require("https");
const FormData = require("form-data");

const app = express();

// Agente HTTPS que permite certificados auto-firmados (para comunicación interna)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Estados de la conversación
const STATES = {
  BOT: "bot",
  CONNECTING: "connecting",
  WITH_AGENT: "with_agent",
};

const END_COMMANDS = new Set(["finalizar", "salir"]);
const SUPPORT_WEBHOOK_URL = process.env.SUPPORT_WEBHOOK_URL;

const sessions = {};

// Helper para enviar mensajes a Gupshup (formato Partner API v3 - igual que server.py)
async function sendGupshupMessage(destination, payload) {
  const apiUrl = process.env.GUPSHUP_API_URL_FINAL || "";

  if (!apiUrl) {
    console.error("❌ GUPSHUP_API_URL_FINAL no está configurado en .env");
    throw new Error("GUPSHUP_API_URL_FINAL no configurado");
  }

  console.log(
    "\n📨 PAYLOAD ORIGINAL RECIBIDO:",
    JSON.stringify(payload, null, 2),
  );

  // Construir payload en formato Partner API v3 (igual que server.py)
  let tipoMensaje = payload.type || "text";
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: destination,
  };

  // Agregar contenido según el tipo de mensaje
  if (tipoMensaje === "text") {
    body.type = "text";
    body.text = {
      body: payload.text || "",
    };
  } else if (tipoMensaje === "quick_reply") {
    // Convertir quick_reply a formato interactive de la API v3
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
            title: (opt.title || "Opción").substring(0, 20), // Máximo 20 caracteres
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
    body.audio = {
      link: payload.url || "",
    };
  } else if (tipoMensaje === "video") {
    body.type = "video";
    body.video = {
      link: payload.url || "",
      caption: payload.caption || "",
    };
  } else {
    // Tipo no reconocido, enviar como texto
    console.log(`⚠️ Tipo "${tipoMensaje}" no reconocido, enviando como texto`);
    body.type = "text";
    body.text = {
      body: payload.text || payload.content?.text || JSON.stringify(payload),
    };
  }

  // Authorization para Partner API (comentado para API estándar)
  // const headers = {
  //   Authorization: process.env.GUPSHUP_API_KEY_FINAL, // Sin "Bearer" - igual que server.py
  //   "Content-Type": "application/json",
  // };
  // Header correcto para API estándar de Gupshup
  const headers = {
    apikey: process.env.GUPSHUP_API_KEY_FINAL,
    "Content-Type": "application/json",
  };

  console.log(
    "\n📤 ========== ENVIANDO MENSAJE GUPSHUP (Partner v3) ==========",
  );
  console.log("🔗 URL:", apiUrl);
  console.log("📱 Destination:", destination);
  console.log("📦 Body:", JSON.stringify(body, null, 2));
  console.log(
    "🔑 Authorization:",
    "***" + process.env.GUPSHUP_API_KEY_FINAL?.slice(-6),
  );

  try {
    const response = await axios.post(apiUrl, body, { headers });

    console.log(`✅ Mensaje enviado a ${destination}`);
    console.log(
      "📥 Respuesta Gupshup:",
      JSON.stringify(response.data, null, 2),
    );
    console.log("========== FIN ENVÍO ==========\n");
    return response.data;
  } catch (error) {
    console.error(`❌ Error enviando mensaje a ${destination}:`, error.message);
    if (error.response) {
      console.error("🔎 Gupshup status:", error.response.status);
      console.error(
        "🔎 Gupshup data:",
        JSON.stringify(error.response.data, null, 2),
      );
    }
    throw error;
  }
}

app.post("/webhook", async (req, res) => {
  const data = req.body;

  // ✅ NUEVO: Detectar cuando el agente ACEPTA la conversación
  if (data.type === "agent_accepted") {
    const numeroAgente = data.numeroAgente;
    const numeroCliente = data.numeroCliente;

    console.log(`\n${"🟢".repeat(35)}`);
    console.log(`✅ AGENTE ACEPTÓ LA CONVERSACIÓN`);
    console.log(`   • Agente: ${numeroAgente}`);
    console.log(`   • Cliente: ${numeroCliente}`);
    console.log(`${"🟢".repeat(35)}\n`);

    // Crear sesión si no existe
    if (!sessions[numeroCliente]) {
      console.log(`📝 Creando sesión para ${numeroCliente}`);
      sessions[numeroCliente] = { step: "menu", state: STATES.BOT };
    }

    // Verificar estado actual
    console.log(`📊 Estado actual de sesión ${numeroCliente}:`);
    console.log(`   • State: ${sessions[numeroCliente].state}`);
    console.log(`   • Step: ${sessions[numeroCliente].step}`);

    // Si ya está con OTRO agente, rechazar
    if (
      sessions[numeroCliente].state === STATES.WITH_AGENT &&
      sessions[numeroCliente].numeroAgente !== numeroAgente
    ) {
      console.warn(
        `⚠️ Cliente ${numeroCliente} ya está con otro agente: ${sessions[numeroCliente].numeroAgente}`,
      );
      return res.sendStatus(200);
    }

    // ✅ CANCELAR EL TIMEOUT si existe
    if (sessions[numeroCliente].timeoutId) {
      clearTimeout(sessions[numeroCliente].timeoutId);
      console.log(`⏰ Timeout cancelado para ${numeroCliente}`);
      delete sessions[numeroCliente].timeoutId;
    }

    // ✅ Establecer sesión
    sessions[numeroCliente].state = STATES.WITH_AGENT;
    sessions[numeroCliente].numeroAgente = numeroAgente;
    sessions[numeroCliente].connectedAt = Date.now(); // Timestamp de conexión

    console.log(`✅ Sesión establecida: ${numeroCliente} ↔ ${numeroAgente}`);

    // ✅ Enviar confirmación al cliente
    const successPayload = {
      type: "text",
      text: `✅ *Agente conectado*\n\nAhora estás en conversación privada con el agente.\n\n📱 Escribe tu consulta aquí.`,
    };

    try {
      await sendGupshupMessage(numeroCliente, successPayload);
      console.log(`✅ Confirmación enviada al cliente ${numeroCliente}`);
    } catch (error) {
      console.error(`❌ Error enviando confirmación:`, error.message);
    }

    return res.sendStatus(200);
  }

  // ✅ NUEVO: Detectar cuando el aplicativo envía fin de chat
  if (data.type === "chat_ended") {
    const numeroCliente = data.numeroCliente || data.from;
    const numeroAgente = data.numeroAgente;

    console.log(`\n${"🔴".repeat(35)}`);
    console.log(`🔚 CHAT FINALIZADO DESDE APLICATIVO`);
    console.log(`   • Cliente: ${numeroCliente}`);
    if (numeroAgente) {
      console.log(`   • Agente: ${numeroAgente}`);
    }
    console.log(`${"🔴".repeat(35)}\n`);

    if (!numeroCliente) {
      console.warn("⚠️ chat_ended sin numeroCliente");
      return res.sendStatus(200);
    }

    // Asegurar sesion y volver al bot
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

    // Mensaje de cierre y vuelta al bot
    try {
      await sendGupshupMessage(numeroCliente, {
        type: "text",
        text: "👋 *Conversacion finalizada*\n\n✅ Has vuelto al chatbot automatico.\n\nEscribe *menu* para ver las opciones.",
      });
      console.log(`✅ Mensaje de cierre enviado a ${numeroCliente}`);
    } catch (error) {
      console.error("❌ Error enviando mensaje de cierre:", error.message);
    }

    return res.sendStatus(200);
  }

  // ✅ Procesar mensajes normales de WhatsApp
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message || !message.from) {
      return res.sendStatus(200);
    }

    const from = message.from;
    let text = "";
    let rawText = "";
    let messageType = "text";

    // Detectar tipo de mensaje y extraer contenido
    switch (message.type) {
      case "text":
        rawText = (message.text?.body || "").trim();
        if (
          rawText.startsWith("{") &&
          rawText.includes('"type":"agent_accepted"')
        ) {
          console.log(
            `🧩 Mensaje interno agent_accepted ignorado para ${from}`,
          );
          return res.sendStatus(200);
        }
        text = rawText.toLowerCase();
        messageType = "text";
        console.log(`📨 Mensaje de texto recibido de ${from}: "${text}"`);
        break;

      case "interactive":
        const interactive = message.interactive;
        const reply = interactive.button_reply || interactive.list_reply;
        if (reply) {
          try {
            const replyData = JSON.parse(reply.id);
            text = replyData.postbackText;
          } catch (e) {
            text = reply.id;
          }
        }
        text = (text || "").toLowerCase().trim();
        messageType = "interactive";
        console.log(`🔘 Interactivo recibido de ${from}: "${text}"`);
        break;

      case "image":
        rawText = message.image?.caption || "";
        text = rawText.toLowerCase();
        messageType = "image";
        console.log(`🖼️ Imagen recibida de ${from}`);
        break;

      case "document":
        rawText = message.document?.caption || message.document?.filename || "";
        text = rawText.toLowerCase();
        messageType = "document";
        console.log(`📄 Documento recibido de ${from}`);
        break;
      case "audio":
        const audioUrl = message.audio?.url || message.audio?.link || "";
        text = "[Audio]";
        messageType = "audio";

        console.log(`🎵 Audio recibido de ${from}: ${audioUrl}`);

        break;
      case "video":
        rawText = message.video?.caption || "";
        text = rawText.toLowerCase();
        messageType = "video";
        console.log(`🎬 Video recibido de ${from}`);
        break;
      case "reaction":
        text = message.reaction?.emoji || "";
        messageType = "reaction";
        console.log(`😀 Reaccion recibida de ${from}: "${text}"`);
        break;

      default:
        console.log(
          `❓ Tipo de mensaje no manejado de ${from}: ${message.type}`,
        );
        return res.sendStatus(200);
    }

    // Inicializar sesión
    if (!sessions[from]) {
      sessions[from] = { step: "menu", state: STATES.BOT };
      console.log(`👤 Nueva sesión creada para ${from}`);
    }

    // 🔥 SINCRONIZAR con el servidor: Verificar si el cliente tiene agente asignado
    try {
      const estadoResponse = await axios.get(
        `${SUPPORT_WEBHOOK_URL.replace("/webhook", "")}/cliente-estado/${from}`,
        { timeout: 3000, httpsAgent },
      );

      if (estadoResponse.data.tieneAgente) {
        console.log(
          `🔄 SINCRONIZACIÓN: ${from} tiene agente ${estadoResponse.data.agente} en servidor`,
        );

        // Actualizar sesión local para que coincida con servidor
        if (sessions[from].state !== STATES.WITH_AGENT) {
          sessions[from].state = STATES.WITH_AGENT;
          sessions[from].numeroAgente = estadoResponse.data.agente;
          console.log(`✅ Sesión local actualizada a WITH_AGENT`);
        }
      }
    } catch (syncError) {
      console.log(
        `⚠️ No se pudo sincronizar estado con servidor: ${syncError.message}`,
      );
    }

    console.log(
      `📊 Estado sesión ${from}: ${sessions[from].state} (step: ${sessions[from].step})`,
    );

    // 🔥 CRÍTICO: Si está con un agente, SOLO reenviar al agente (NO procesar en bot)
    if (sessions[from].state === STATES.WITH_AGENT) {
      // Solo permitir comandos de salida
      if (END_COMMANDS.has(text)) {
        console.log(`\n${"🔴".repeat(35)}`);
        console.log(`🔚 Usuario ${from} finalizó conversación con agente`);
        console.log(`${"🔴".repeat(35)}\n`);

        // Limpiar datos de la sesión con agente
        const numeroAgente = sessions[from].numeroAgente;
        sessions[from].state = STATES.BOT;
        sessions[from].step = "menu";
        delete sessions[from].numeroAgente;
        delete sessions[from].connectedAt;

        if (sessions[from].timeoutId) {
          clearTimeout(sessions[from].timeoutId);
          delete sessions[from].timeoutId;
        }

        // Mensaje claro de finalización
        await sendGupshupMessage(from, {
          type: "text",
          text: "👋 *Conversación con agente finalizada*\n\n✅ Has vuelto al chatbot automático.\n\nAhora puedo ayudarte con:\n• Ver el menú principal\n• Solicitar nuevo soporte\n• Información de ventas\n\nEscribe *menu* para ver las opciones.",
        });

        // Notificar al servidor de soporte
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
          console.log(`✅ Fin de chat notificado al servidor para ${from}`);
        } catch (e) {
          console.error("❌ Error notificando fin de chat:", e.message);
        }

        return res.sendStatus(200);
      }

      // 🔥 Reenviar CUALQUIER otro mensaje al agente (incluyendo "menu")
      console.log(
        `📤 Cliente ${from} CON AGENTE - Reenviando mensaje al servidor...`,
      );

      let payloadToSupport = {
        from,
        text: rawText || text || "",
        type: "incoming_message",
        message_type: messageType,
        timestamp: new Date().toISOString(),
        object: "whatsapp_business_account",
        ...(messageType === "image" && {
          mediaUrl: message.image?.id || "",
          url: message.image?.url || "", // ← AGREGAR
          mime_type: message.image?.mime_type || "image/jpeg", // ← AGREGAR
          caption: message.image?.caption || "",
        }),
        ...(messageType === "document" && {
          mediaUrl: message.document?.id || "",
          url: message.document?.url || "", // ← AGREGAR
          mime_type: message.document?.mime_type || "application/octet-stream", // ← AGREGAR
          filename: message.document?.filename || "",
          caption: message.document?.caption || "",
        }),
        ...(messageType === "audio" && {
          mediaUrl: message.audio?.id || "",
          url: message.audio?.url || "", // ← AGREGAR
          mime_type: message.audio?.mime_type || "audio/mpeg", // ← AGREGAR
        }),
        ...(messageType === "video" && {
          mediaUrl: message.video?.id || "",
          url: message.video?.url || "", // ← AGREGAR
          mime_type: message.video?.mime_type || "video/mp4", // ← AGREGAR
          caption: message.video?.caption || "",
        }),
      };

      try {
        await axios.post(SUPPORT_WEBHOOK_URL, payloadToSupport, {
          timeout: 10000,
          httpsAgent,
        });
        console.log(`✅ Mensaje reenviado al servidor`);
      } catch (e) {
        console.error("❌ Error reenviando al soporte:", e.message);
      }
      return res.sendStatus(200);
    }

    // Si está conectando, ignorar mensajes
    if (sessions[from].state === STATES.CONNECTING) {
      console.log(
        `⏳ Usuario ${from} está esperando agente, ignorando mensaje`,
      );
      return res.sendStatus(200);
    }

    // Reset al menú (solo si NO está con agente)
    if (text === "menu" || text === "menú") {
      // Limpiar timeout si existe
      if (sessions[from].timeoutId) {
        clearTimeout(sessions[from].timeoutId);
        delete sessions[from].timeoutId;
      }

      sessions[from].step = "menu";
      sessions[from].state = STATES.BOT;
      console.log(`🔄 Sesión reiniciada para ${from}`);
    }

    let messagePayload = null;

    // FLUJO DEL BOT - MENÚ PRINCIPAL
    if (sessions[from].step === "menu") {
      console.log(`📋 Mostrando menú principal a ${from}`);
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
    }
    // FLUJO DEL BOT - OPCIONES
    else if (sessions[from].step === "option") {
      if (text === "btn_soporte" || text === "soporte") {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`🔄 Usuario ${from} solicita soporte`);
        console.log(`${"=".repeat(60)}\n`);

        // ✅ Cambiar estado a CONNECTING
        sessions[from].state = STATES.CONNECTING;
        sessions[from].requestTime = Date.now();

        // ✅ Enviar mensaje de espera
        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        };

        await sendGupshupMessage(from, messagePayload);
        console.log(`📤 Mensaje de espera enviado a ${from}`);

        try {
          await axios.post(
            process.env.SUPPORT_WEBHOOK_URL,
            {
              from: from,
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

          console.log(
            `✅ Solicitud de soporte enviada (esperando aceptación...)`,
          );

          // ⏰ Guardar el ID del timeout para poder cancelarlo después
          const timeoutId = setTimeout(() => {
            // Verificar que la sesión AÚN existe y AÚN está en CONNECTING
            if (sessions[from] && sessions[from].state === STATES.CONNECTING) {
              console.log(`⏰ Timeout para ${from} - sin respuesta de agente`);
              sessions[from].state = STATES.BOT;
              sessions[from].step = "menu";
              delete sessions[from].timeoutId;

              sendGupshupMessage(from, {
                type: "text",
                text: "⏰ No hay agentes disponibles en este momento.\n\nEscribe *menu* para ver otras opciones.",
              });
            } else {
              console.log(
                `⏰ Timeout ignorado para ${from} - ya está conectado`,
              );
            }
          }, 120000); // 2 minutos

          // Guardar el ID del timeout en la sesión
          sessions[from].timeoutId = timeoutId;
          console.log(`⏰ Timeout programado para ${from} (ID: ${timeoutId})`);
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
        console.log(`💰 Usuario ${from} solicita información de ventas`);
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nVisita nuestra web: https://tuapp.com/ventas\n\nEscribe *menu* para volver.",
        };
        sessions[from].step = "menu";
      } else {
        console.log(`⚠️ Entrada inválida de ${from}: "${text}"`);
        messagePayload = {
          type: "text",
          text: "❌ No entendí tu respuesta.\n\nEscribe *menu* para ver las opciones disponibles.",
        };
      }
    }

    // ✅ Enviar respuesta final si existe un payload
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
