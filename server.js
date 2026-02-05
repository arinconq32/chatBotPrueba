require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPPORT_WEBHOOK_URL =
  process.env.SUPPORT_WEBHOOK_URL ||
  "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook";

// Estados de la conversación
const STATES = {
  BOT: "bot",
  CONNECTING: "connecting",
  WITH_AGENT: "with_agent",
};

const sessions = {};

// Helper para enviar mensajes a Gupshup
async function sendGupshupMessage(destination, payload) {
  const params = new URLSearchParams({
    channel: "whatsapp",
    source: process.env.GS_SOURCE_NUMBER || "919999900095",
    destination: destination,
    message: JSON.stringify(payload),
    "src.name": process.env.GUPSHUP_APP_NAME || "chatbotPruebas32",
  });

  try {
    const response = await axios.post(
      "https://api.gupshup.io/wa/api/v1/msg",
      params.toString(),
      {
        headers: {
          apikey: process.env.GUPSHUP_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache",
        },
      },
    );
    console.log(`✅ Mensaje enviado a ${destination}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error enviando mensaje a ${destination}:`, error.message);
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

    // ✅ Establecer sesión
    sessions[numeroCliente].state = STATES.WITH_AGENT;
    sessions[numeroCliente].numeroAgente = numeroAgente;

    console.log(`✅ Sesión establecida: ${numeroCliente} ↔ ${numeroAgente}`);

    // ✅ Enviar confirmación al cliente
    const successPayload = {
      type: "text",
      text: `✅ *Agente conectado*\n\nAhora estás en conversación privada con el agente *${numeroAgente}*.\n\n📱 Escribe tu consulta aquí.`,
    };

    try {
      await sendGupshupMessage(numeroCliente, successPayload);
      console.log(`✅ Confirmación enviada al cliente ${numeroCliente}`);
    } catch (error) {
      console.error(`❌ Error enviando confirmación:`, error.message);
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
    let messageType = "text";

    // Detectar tipo de mensaje y extraer contenido
    switch (message.type) {
      case "text":
        text = message.text.body.toLowerCase().trim();
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
        messageType = "interactive";
        console.log(`🔘 Interactivo recibido de ${from}: "${text}"`);
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
        await axios.post(
          SUPPORT_WEBHOOK_URL,
          payloadToSupport,
          { timeout: 10000 },
        );
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
        sessions[from].requestTime = Date.now(); // ← Guardar timestamp

        // ✅ Enviar mensaje de espera
        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        };

        await sendGupshupMessage(from, messagePayload);
        console.log(`📤 Mensaje de espera enviado a ${from}`);

        try {
          await axios.post(
            SUPPORT_WEBHOOK_URL,
            {
              from: from,
              text: "soporte",
              tipo: "text",
              type: "support_request", // ← Cambiar tipo
              message_type: "text",
              object: "whatsapp_business_account",
              timestamp: new Date().toISOString(),
              cola: "PRUEBAS",
              pausa: 1,
            },
            { timeout: 10000 },
          );

          console.log(
            `✅ Solicitud de soporte enviada (esperando aceptación...)`,
          );
          console.log(
            `✅ Solicitud de soporte enviada (esperando aceptación...)`,
          );

          // ⏰ Timeout de 2 minutos si no hay respuesta
          setTimeout(() => {
            if (sessions[from] && sessions[from].state === STATES.CONNECTING) {
              console.log(`⏰ Timeout para ${from} - sin respuesta de agente`);
              sessions[from].state = STATES.BOT;
              sessions[from].step = "menu";

              sendGupshupMessage(from, {
                type: "text",
                text: "⏰ No hay agentes disponibles en este momento.\n\nEscribe *menu* para ver otras opciones.",
              });
            }
          }, 120000); // 2 minutos
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot servidor en puerto ${PORT}`));
