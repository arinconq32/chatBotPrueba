require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
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

// Helper para enviar mensajes a Gupshup
async function sendGupshupMessage(destination, payload) {
  const apiUrl = process.env.GUPSHUP_API_URL_FINAL || "";
  const isPartnerV3 = apiUrl.includes("partner.gupshup.io");
  const body = {
    channel: "whatsapp",
    source: process.env.GUPSHUP_SOURCE,
    destination: destination,
    message: payload,
    "src.name": process.env.GUPSHUP_APP_NAME,
  };

  try {
    const response = await axios.post(apiUrl, isPartnerV3 ? body : new URLSearchParams({
      channel: body.channel,
      source: body.source,
      destination: body.destination,
      message: JSON.stringify(body.message),
      "src.name": body["src.name"],
    }).toString(), {
      headers: {
        apikey: process.env.GUPSHUP_API_KEY_FINAL,
        "Content-Type": isPartnerV3
          ? "application/json"
          : "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
    });
    console.log(`✅ Mensaje enviado a ${destination}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error enviando mensaje a ${destination}:`, error.message);
    if (error.response) {
      console.error("🔎 Gupshup status:", error.response.status);
      console.error("🔎 Gupshup data:", error.response.data);
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

    // Verificar que la sesión existe
    if (!sessions[numeroCliente]) {
      console.warn(`⚠️ No existe sesión para ${numeroCliente}`);
      console.warn(`   Sesiones activas:`, Object.keys(sessions));
      return res.sendStatus(200);
    }

    // Verificar estado
    console.log(`📊 Estado actual de sesión ${numeroCliente}:`);
    console.log(`   • State: ${sessions[numeroCliente].state}`);
    console.log(`   • Step: ${sessions[numeroCliente].step}`);

    if (sessions[numeroCliente].state !== STATES.CONNECTING) {
      console.warn(`⚠️ Cliente ${numeroCliente} NO está en CONNECTING`);
      console.warn(`   Estado actual: ${sessions[numeroCliente].state}`);
      return res.sendStatus(200);
    }

    // ✅ CANCELAR EL TIMEOUT antes de establecer la conexión
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

    // Si ya está con un agente, reenviar mensaje
    if (sessions[from].state === STATES.WITH_AGENT) {
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
            { timeout: 10000 },
          );
          console.log(`✅ Fin de chat notificado al servidor para ${from}`);
        } catch (e) {
          console.error("❌ Error notificando fin de chat:", e.message);
        }

        return res.sendStatus(200);
      }

      console.log(`📤 Reenviando mensaje de ${from} al agente...`);

      let payloadToSupport = {
        from,
        text: text || "",
        type: "incoming_message",
        message_type: messageType,
        timestamp: new Date().toISOString(),
        object: "whatsapp_business_account",
      };

      try {
        await axios.post(SUPPORT_WEBHOOK_URL, payloadToSupport, {
          timeout: 10000,
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

    // Reset al menú
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
              cola: "PRUEBAS",
              pausa: 2,
            },
            { timeout: 10000 },
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Bot servidor en puerto ${PORT}`));
