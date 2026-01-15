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

    // Detectar si es texto normal o respuesta de lista
    if (message.text && message.text.body) {
      text = message.text.body.toLowerCase().trim();
    } else if (
      message.interactive &&
      message.interactive.type === "list_reply"
    ) {
      text = message.interactive.list_reply.id; // ID de la opción seleccionada
    }

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
      // MENSAJE CON LISTA
      messagePayload = {
        type: "interactive",
        interactive: {
          type: "list",
          header: {
            type: "text",
            text: "Menú Principal",
          },
          body: {
            text: "👋 ¡Bienvenido a nuestra empresa!\n\nSelecciona una opción del menú:",
          },
          footer: {
            text: "Estamos aquí para ayudarte",
          },
          action: {
            button: "Ver opciones",
            sections: [
              {
                title: "Servicios",
                rows: [
                  {
                    id: "opt_soporte",
                    title: "🛠️ Soporte Técnico",
                    description: "Ayuda con problemas técnicos",
                  },
                  {
                    id: "opt_ventas",
                    title: "💰 Ventas",
                    description: "Conoce nuestros productos",
                  },
                  {
                    id: "opt_asesor",
                    title: "👤 Hablar con Asesor",
                    description: "Contacto directo con un experto",
                  },
                ],
              },
              {
                title: "Información",
                rows: [
                  {
                    id: "opt_horarios",
                    title: "🕐 Horarios",
                    description: "Ver horarios de atención",
                  },
                  {
                    id: "opt_ubicacion",
                    title: "📍 Ubicación",
                    description: "¿Dónde estamos?",
                  },
                ],
              },
            ],
          },
        },
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
