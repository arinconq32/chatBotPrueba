require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Estados de la conversación
const STATES = {
  BOT: "bot",
  WITH_AGENT: "with_agent",
};

const sessions = {};

// Helper para enviar mensajes a Gupshup
async function sendGupshupMessage(destination, payload) {
  const params = new URLSearchParams({
    channel: "whatsapp",
    source: process.env.GS_SOURCE_NUMBER,
    destination: destination,
    message: JSON.stringify(payload),
    "src.name": process.env.GUPSHUP_APP_NAME,
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
      console.log(`Forwarding message from ${from} to external support...`);
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
        console.error("Error forwarding to support:", e.message);
      }
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
        console.log(
          `--- Intentando conectar ${from} con soporte (10s timeout) ---`
        );

        try {
          // 1. Intentar POST al webhook externo con límite de 10 segundos
          await axios.post(
            "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook",
            {
              from: from,
              event: "support_requested",
              timestamp: new Date().toISOString(),
            },
            { timeout: 10000 } // 10000 ms = 10 segundos
          );

          // 2. Si responde a tiempo, activar modo agente
          sessions[from].state = STATES.WITH_AGENT;
          messagePayload = {
            type: "text",
            text: "🛠️ *Conectando con Soporte*\n\n✅ Un agente ha sido notificado y te atenderá en breve.\n\n_Ahora estás en chat directo._",
          };
        } catch (error) {
          // 3. Si falla o tarda más de 10s
          console.log(
            `⚠️ Soporte no disponible para ${from}: ${
              error.code === "ECONNABORTED" ? "Timeout" : "Error"
            }`
          );

          messagePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n⚠️ Lo sentimos, en este momento no hay agentes disponibles o el tiempo de espera ha expirado.\n\n💡 Escribe *menu* para volver a intentar más tarde.",
          };
          sessions[from].step = "menu";
        }
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

// Endpoint para que el agente responda desde la plataforma externa
app.post("/agent/send-message", async (req, res) => {
  try {
    const { destination, message } = req.body;

    if (
      !sessions[destination] ||
      sessions[destination].state !== STATES.WITH_AGENT
    ) {
      return res.status(403).json({ error: "Sesión no está en modo agente" });
    }

    await sendGupshupMessage(destination, { type: "text", text: message });
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("Bot Online 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
