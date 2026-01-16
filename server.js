require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Estados posibles de una conversación
const STATES = {
  BOT: "bot",
  WITH_AGENT: "with_agent",
};

const sessions = {};

// URL de tu plataforma de agentes
const PLATFORM_WEBHOOK_URL =
  "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook";

// Función para enviar mensajes a tu plataforma
async function sendToPlatform(from, message, messageData = {}) {
  try {
    const payload = {
      from: from,
      message: message,
      timestamp: new Date().toISOString(),
      messageType: messageData.type || "text",
      fullMessageData: messageData, // Incluye el mensaje completo de WhatsApp
    };

    console.log(
      `📨 Enviando a plataforma ${PLATFORM_WEBHOOK_URL}:`,
      JSON.stringify(payload, null, 2)
    );

    const response = await axios.post(PLATFORM_WEBHOOK_URL, payload, {
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 5000, // 5 segundos de timeout
    });

    console.log(`✅ Respuesta de plataforma:`, response.data);
    return true;
  } catch (error) {
    console.error(`❌ Error al enviar a plataforma:`, error.message);
    if (error.response) {
      console.error(`❌ Detalles del error:`, error.response.data);
    }
    return false;
  }
}

app.post("/webhook", async (req, res) => {
  try {
    console.log("========================================");
    console.log("📥 WEBHOOK RECIBIDO:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("========================================");

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message || !message.from) {
      console.log("⚠️ Evento sin remitente (ignorado)");
      return res.sendStatus(200);
    }

    const from = message.from;
    let text = "";

    // Detectar tipo de mensaje
    if (message.text && message.text.body) {
      text = message.text.body.toLowerCase().trim();
    } else if (message.type === "interactive") {
      if (message.interactive && message.interactive.button_reply) {
        try {
          const replyData = JSON.parse(message.interactive.button_reply.id);
          text = replyData.postbackText;
        } catch (e) {
          text = message.interactive.button_reply.id;
        }
      } else if (message.interactive && message.interactive.list_reply) {
        try {
          const replyData = JSON.parse(message.interactive.list_reply.id);
          text = replyData.postbackText;
        } catch (e) {
          text = message.interactive.list_reply.id;
        }
      }
    }

    console.log("✅ Tipo de mensaje:", message.type);
    console.log("✅ Texto/ID extraído:", text);
    console.log("✅ From extraído:", from);

    // Inicializar sesión
    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        state: STATES.BOT,
      };
    }

    // ⭐ IMPORTANTE: Si la conversación está con un agente, enviar TODO a la plataforma
    if (sessions[from].state === STATES.WITH_AGENT) {
      console.log(
        "🔄 Conversación en modo AGENTE - enviando mensaje a plataforma"
      );

      // Enviar el mensaje completo a tu plataforma
      await sendToPlatform(from, text, message);

      // No enviar respuesta automática del bot
      // El agente responderá desde tu plataforma
      return res.status(200).json({
        status: "forwarded_to_agent",
        message: "Mensaje reenviado a plataforma de agentes",
      });
    }

    // Reset al menú (solo si está en modo bot)
    if (text === "menu" || text === "menú") {
      sessions[from].step = "menu";
      sessions[from].state = STATES.BOT;
    }

    let messagePayload = null;

    // Flujo del bot
    if (sessions[from].step === "menu") {
      messagePayload = {
        type: "quick_reply",
        msgid: "menu_principal",
        content: {
          type: "text",
          text: "👋 ¡Bienvenido a nuestra empresa!\n\n¿En qué podemos ayudarte hoy?",
          caption: "Selecciona una opción:",
        },
        options: [
          {
            type: "text",
            title: "🛠️ Soporte",
            postbackText: "btn_soporte",
          },
          {
            type: "text",
            title: "💰 Ventas",
            postbackText: "btn_ventas",
          },
          {
            type: "text",
            title: "👤 Asesor",
            postbackText: "btn_asesor",
          },
        ],
      };
      sessions[from].step = "option";
    } else if (sessions[from].step === "option") {
      if (text === "btn_soporte") {
        // ⭐ Cambiar estado a modo agente
        sessions[from].state = STATES.WITH_AGENT;

        // ⭐ Enviar notificación inicial a la plataforma
        const sent = await sendToPlatform(from, "INICIO_SOPORTE", {
          type: "support_request",
          action: "conversation_started",
        });

        if (sent) {
          console.log(`✅ Usuario ${from} ahora en modo AGENTE`);

          messagePayload = {
            type: "text",
            text: "🛠️ *Conectando con Soporte*\n\n✅ Un agente está revisando tu caso...\nEn breve te responderá.\n\n_Ahora estás chateando con un agente humano._\n\n💡 Escribe tu consulta y un agente te responderá.",
          };
        } else {
          // Si falla el envío a la plataforma, volver a modo bot
          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";

          messagePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n⚠️ No pudimos conectar con nuestro sistema de agentes.\n\nPor favor intenta de nuevo en unos momentos.\n\n💡 Escribe *menu* para volver al inicio.",
          };
        }
      } else if (text === "btn_ventas") {
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nConoce nuestros productos y servicios:\n👉 https://tuapp.com/ventas\n\n💡 Escribe *menu* para volver al inicio.",
        };
        sessions[from].step = "menu";
      } else if (text === "btn_asesor") {
        messagePayload = {
          type: "text",
          text: "👤 *Asesor Humano*\n\nUn asesor se comunicará contigo pronto.\n⏰ L–V 9am–6pm\n\n💡 Escribe *menu* para volver al inicio.",
        };
        sessions[from].step = "menu";
      } else {
        messagePayload = {
          type: "text",
          text: "❌ Opción no válida\n\nEscribe *menu* para reiniciar",
        };
      }
    }

    console.log("📤 Enviando respuesta a WhatsApp");

    const params = new URLSearchParams({
      channel: "whatsapp",
      source: process.env.GS_SOURCE_NUMBER,
      destination: from,
      message: JSON.stringify(messagePayload),
      "src.name": process.env.GUPSHUP_APP_NAME,
    });

    console.log("📦 Datos POST enviados:", params.toString());

    const response = await axios.post(
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

    console.log("✅ Respuesta de Gupshup:", response.data);

    res.status(200).json({
      status: "success",
      message: messagePayload,
      gupshup_response: response.data,
    });
  } catch (err) {
    console.error("❌ ERROR completo:", err.message);
    console.error("❌ ERROR data:", err.response?.data);
    console.error("❌ ERROR status:", err.response?.status);
    res.sendStatus(200);
  }
});

// ⭐ Endpoint para que tu plataforma envíe respuestas al usuario
app.post("/platform/send-message", async (req, res) => {
  try {
    const { destination, message } = req.body;

    if (!destination || !message) {
      return res.status(400).json({
        error: "Faltan parámetros requeridos",
        required: ["destination", "message"],
      });
    }

    // Verificar que la conversación esté en modo agente
    if (
      !sessions[destination] ||
      sessions[destination].state !== STATES.WITH_AGENT
    ) {
      return res.status(403).json({
        error: "Esta conversación no está asignada a un agente",
        currentState: sessions[destination]?.state || "sin_sesion",
      });
    }

    console.log(`📤 Plataforma enviando mensaje a ${destination}`);

    const messagePayload = {
      type: "text",
      text: message,
    };

    const params = new URLSearchParams({
      channel: "whatsapp",
      source: process.env.GS_SOURCE_NUMBER,
      destination: destination,
      message: JSON.stringify(messagePayload),
      "src.name": process.env.GUPSHUP_APP_NAME,
    });

    const response = await axios.post(
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

    console.log("✅ Mensaje de plataforma enviado correctamente");

    res.status(200).json({
      status: "success",
      gupshup_response: response.data,
    });
  } catch (err) {
    console.error("❌ ERROR al enviar mensaje desde plataforma:", err.message);
    res.status(500).json({
      error: "Error al enviar mensaje",
      details: err.message,
    });
  }
});

// ⭐ Endpoint para finalizar conversación con agente
app.post("/platform/end-conversation", async (req, res) => {
  try {
    const { destination } = req.body;

    if (!destination) {
      return res.status(400).json({ error: "Falta parámetro: destination" });
    }

    if (sessions[destination]) {
      sessions[destination].state = STATES.BOT;
      sessions[destination].step = "menu";

      console.log(
        `✅ Conversación ${destination} finalizada - volviendo a modo bot`
      );

      res.status(200).json({
        status: "success",
        message: "Conversación finalizada",
      });
    } else {
      res.status(404).json({ error: "Sesión no encontrada" });
    }
  } catch (err) {
    console.error("❌ ERROR al finalizar conversación:", err.message);
    res.status(500).json({ error: "Error al finalizar conversación" });
  }
});

app.get("/webhook", (req, res) => {
  res.send("Webhook activo ✅");
});

app.get("/", (req, res) => {
  res.send("🤖 Bot WhatsApp con integración de agentes ✅");
});

// ⭐ Endpoint para verificar estado de sesión (útil para debugging)
app.get("/session/:phone", (req, res) => {
  const phone = req.params.phone;
  const session = sessions[phone];

  if (session) {
    res.json({
      phone: phone,
      session: session,
    });
  } else {
    res.status(404).json({ error: "Sesión no encontrada" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`📡 Plataforma de agentes: ${PLATFORM_WEBHOOK_URL}`);
});
