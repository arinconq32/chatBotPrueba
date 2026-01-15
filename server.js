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
        text = message.interactive.button_reply.id;
      } else if (message.interactive && message.interactive.list_reply) {
        text = message.interactive.list_reply.id;
      }
    }

    console.log("✅ Tipo de mensaje:", message.type);
    console.log("✅ Mensaje completo:", JSON.stringify(message, null, 2));
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
      // FORMATO CORRECTO DE GUPSHUP PARA LISTAS
      messagePayload = {
        type: "list",
        title: "Menú Principal",
        body: "👋 ¡Bienvenido a nuestra empresa!\n\n¿En qué podemos ayudarte hoy?",
        footer: "Estamos aquí para ayudarte",
        msgid: "menu_principal",
        globalButtons: [
          {
            type: "text",
            title: "Ver opciones",
          },
        ],
        items: [
          {
            title: "Servicios",
            subtitle: "Nuestros servicios principales",
            options: [
              {
                type: "text",
                title: "🛠️ Soporte Técnico",
                description: "Ayuda con problemas técnicos",
                postbackText: "opt_soporte",
              },
              {
                type: "text",
                title: "💰 Ventas",
                description: "Conoce nuestros productos",
                postbackText: "opt_ventas",
              },
              {
                type: "text",
                title: "👤 Hablar con Asesor",
                description: "Contacto directo con experto",
                postbackText: "opt_asesor",
              },
            ],
          },
          {
            title: "Información",
            subtitle: "Datos de contacto",
            options: [
              {
                type: "text",
                title: "🕐 Horarios",
                description: "Ver horarios de atención",
                postbackText: "opt_horarios",
              },
              {
                type: "text",
                title: "📍 Ubicación",
                description: "¿Dónde estamos?",
                postbackText: "opt_ubicacion",
              },
            ],
          },
        ],
      };
      sessions[from].step = "option";
    } else if (sessions[from].step === "option") {
      if (text === "opt_soporte") {
        messagePayload = {
          type: "text",
          text: "🛠️ *Soporte Técnico*\n\nAquí puedes encontrar soluciones a tus problemas:\n👉 https://tuapp.com/soporte\n\n💡 Escribe *menu* para volver al inicio.",
        };
        sessions[from].step = "menu";
      } else if (text === "opt_ventas") {
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nConoce nuestros productos y servicios:\n👉 https://tuapp.com/ventas\n\n💡 Escribe *menu* para volver al inicio.",
        };
        sessions[from].step = "menu";
      } else if (text === "opt_asesor") {
        messagePayload = {
          type: "text",
          text: "👤 *Asesor Humano*\n\nUn asesor se comunicará contigo pronto.\n⏰ L–V 9am–6pm\n\n💡 Escribe *menu* para volver al inicio.",
        };
        sessions[from].step = "menu";
      } else if (text === "opt_horarios") {
        messagePayload = {
          type: "text",
          text: "🕐 *Horarios de Atención*\n\nLunes a Viernes: 9:00 AM - 6:00 PM\nSábados: 9:00 AM - 1:00 PM\nDomingos: Cerrado\n\n💡 Escribe *menu* para volver al inicio.",
        };
        sessions[from].step = "menu";
      } else if (text === "opt_ubicacion") {
        messagePayload = {
          type: "text",
          text: "📍 *Nuestra Ubicación*\n\nCalle Principal #123\nBogotá, Colombia\n\n🗺️ Ver en mapa: https://maps.google.com\n\n💡 Escribe *menu* para volver al inicio.",
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
  res.send("🤖 Bot WhatsApp con Listas activo 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});
