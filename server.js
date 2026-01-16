require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

  return await axios.post(
    "https://api.gupshup.io/wa/api/v1/msg",
    params.toString(),
    {
      headers: {
        apikey: process.env.GUPSHUP_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
    }
  );
}

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message || !message.from) {
      return res.sendStatus(200);
    }

    const from = message.from;
    let text = "";

    // Extraer texto o ID de botones
    if (message.text && message.text.body) {
      text = message.text.body.toLowerCase().trim();
    } else if (message.type === "interactive") {
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
    }

    // Inicializar sesión
    if (!sessions[from]) {
      sessions[from] = { step: "menu", state: STATES.BOT };
    }

    // Si ya está con un agente, reenviar mensaje a la plataforma externa
    if (sessions[from].state === STATES.WITH_AGENT) {
      console.log(`📤 Reenviando mensaje de ${from} al soporte...`);
      try {
        await axios.post(
          "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook",
          {
            from,
            text,
            type: "incoming_message",
          }
        );
      } catch (e) {
        console.error("❌ Error reenviando al soporte:", e.message);
      }
      return res.sendStatus(200);
    }

    // Si está conectando, ignorar mensajes hasta que termine
    if (sessions[from].state === STATES.CONNECTING) {
      console.log(
        `⏳ Usuario ${from} está en proceso de conexión, ignorando mensaje`
      );
      return res.sendStatus(200);
    }

    // Reset al menú
    if (text === "menu" || text === "menú") {
      sessions[from].step = "menu";
      sessions[from].state = STATES.BOT;
    }

    let messagePayload = null;

    // FLUJO DEL BOT
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
      if (text === "btn_soporte") {
        console.log(`🔄 Usuario ${from} solicita soporte...`);

        // ===== PASO 1: Guardar "soporte" en el chat =====
        try {
          await axios.post(
            "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook",
            {
              from: from,
              text: "soporte",
              type: "incoming_message",
            },
            { timeout: 5000 }
          );
          console.log(`✅ Mensaje 'soporte' guardado en el chat`);
        } catch (e) {
          console.error("⚠️ Error guardando 'soporte' en chat:", e.message);
        }

        // ===== PASO 2: Cambiar estado a CONNECTING =====
        sessions[from].state = STATES.CONNECTING;

        // ===== PASO 3: Aviso de conexión en progreso =====
        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        };

        await sendGupshupMessage(from, messagePayload);

        // ===== PASO 4: Intentar conexión al webhook externo =====
        console.log(
          `--- Intentando conectar ${from} con soporte (10s timeout) ---`
        );

        try {
          const response = await axios.post(
            "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook",
            {
              from: from,
              text: "soporte",
              type: "incoming_message",
              event: "support_requested",
              object: "whatsapp_business_account",
              timestamp: new Date().toISOString(),
            },
            { timeout: 10000 }
          );

          console.log(`✅ Agente conectado para ${from}`);

          // ===== PASO 5: Éxito - Aviso de conexión exitosa =====
          sessions[from].state = STATES.WITH_AGENT;
          messagePayload = {
            type: "text",
            text: "🛠️ *Soporte Conectado*\n\n✅ Un agente está listo para ayudarte.\n\n_Ahora estás en chat directo con nuestro equipo de soporte._",
          };

          await sendGupshupMessage(from, messagePayload);
        } catch (error) {
          // ===== PASO 5: Error - Aviso de falla de conexión =====
          const errorType =
            error.code === "ECONNABORTED" ? "Timeout (>10s)" : error.message;
          console.log(`❌ Soporte no disponible para ${from}: ${errorType}`);

          // Restablecer estado a BOT
          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";

          messagePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n❌ Lo sentimos, en este momento no hay agentes disponibles.\n\n💡 Escribe *menu* para intentar más tarde o elige otra opción.",
          };

          await sendGupshupMessage(from, messagePayload);
        }

        // Retornar aquí porque ya enviamos los mensajes
        return res.sendStatus(200);
      } else if (text === "btn_ventas") {
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nVisita nuestra web: https://tuapp.com/ventas\n\nEscribe *menu* para volver.",
        };
        sessions[from].step = "menu";
      }
    }

    // Enviar respuesta final si existe un payload
    if (messagePayload) {
      await sendGupshupMessage(from, messagePayload);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error Webhook:", err.message);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => res.send("Bot Online 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
