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

    // ⭐ Si la conversación está con un agente, reenviar a tu plataforma
    if (sessions[from].state === STATES.WITH_AGENT) {
      console.log("🔄 Conversación en modo AGENTE - reenviando a plataforma");

      try {
        // Reenviar el mensaje completo a tu plataforma
        const platformResponse = await axios.post(
          PLATFORM_WEBHOOK_URL,
          req.body, // Enviar el body completo tal cual llega de WhatsApp
          {
            headers: {
              "Content-Type": "application/json",
            },
            timeout: 5000, // 5 segundos de timeout
          }
        );

        console.log("✅ Mensaje reenviado a plataforma exitosamente");
        console.log("✅ Respuesta de plataforma:", platformResponse.data);

        // Tu plataforma maneja todo desde ahí
        return res.status(200).json({
          status: "forwarded_to_platform",
          message: "Mensaje reenviado a agente",
        });
      } catch (error) {
        console.error("❌ Error al reenviar a plataforma:", error.message);

        // ⭐ Si falla, responder con mensaje automático
        const fallbackPayload = {
          type: "text",
          text: "⚠️ Lo sentimos, estamos experimentando problemas de conexión.\n\nPor favor intenta de nuevo en unos momentos.\n\n💡 Escribe *menu* para volver al inicio.",
        };

        const params = new URLSearchParams({
          channel: "whatsapp",
          source: process.env.GS_SOURCE_NUMBER,
          destination: from,
          message: JSON.stringify(fallbackPayload),
          "src.name": process.env.GUPSHUP_APP_NAME,
        });

        await axios.post(
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

        return res.status(200).json({
          status: "platform_error_fallback_sent",
          error: error.message,
        });
      }
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
        // ⭐ Cambiar a modo agente
        sessions[from].state = STATES.WITH_AGENT;

        console.log(`✅ Usuario ${from} ahora en modo AGENTE`);

        // ⭐ Notificar a la plataforma que se inició conversación
        try {
          await axios.post(
            PLATFORM_WEBHOOK_URL,
            {
              event: "conversation_started",
              from: from,
              timestamp: new Date().toISOString(),
            },
            {
              headers: { "Content-Type": "application/json" },
              timeout: 3000,
            }
          );
        } catch (error) {
          console.error(
            "⚠️ No se pudo notificar inicio a plataforma:",
            error.message
          );
        }

        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n✅ Un agente está revisando tu caso...\n\n_Escribe tu consulta y un agente te responderá._",
        };
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

app.get("/webhook", (req, res) => {
  res.send("Webhook activo ✅");
});

app.get("/", (req, res) => {
  res.send("🤖 Bot WhatsApp activo ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`📡 Plataforma de agentes: ${PLATFORM_WEBHOOK_URL}`);
});
