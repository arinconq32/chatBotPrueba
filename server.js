require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Memoria simple por usuario
const sessions = {};

app.post("/webhook", async (req, res) => {
  try {
    console.log("========================================");
    console.log("📩 WEBHOOK RECIBIDO:");
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
      // Mensaje de texto normal
      text = message.text.body.toLowerCase().trim();
    } else if (message.type === "interactive") {
      // Respuesta de botón o lista en formato Gupshup
      if (message.interactive && message.interactive.button_reply) {
        // El ID viene como JSON stringificado, necesitamos parsearlo
        try {
          const replyData = JSON.parse(message.interactive.button_reply.id);
          text = replyData.postbackText;
        } catch (e) {
          // Si no es JSON, usar directamente el ID
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
      sessions[from] = { step: "menu" };
    }

    // Reset al menú
    if (text === "menu" || text === "menú") {
      sessions[from].step = "menu";
    }

    let messagePayload = null;

    // Flujo del bot
    if (sessions[from].step === "menu") {
      // FORMATO CORRECTO DE GUPSHUP PARA BOTONES (QUICK REPLY)
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
        messagePayload = {
          type: "text",
          text: "🛠️ *Soporte Técnico*\n\nAquí puedes encontrar soluciones a tus problemas:\n👉 https://tuapp.com/soporte\n\n💡 Escribe *menu* para volver al inicio.",
        };
        sessions[from].step = "menu";
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
  res.send("🤖 Bot WhatsApp con Botones activo 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});
