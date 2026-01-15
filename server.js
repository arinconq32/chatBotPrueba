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

    // Extraer texto del mensaje
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    // Validar que exista un mensaje de texto
    if (!message || !message.text || !message.text.body || !message.from) {
      console.log("⚠️ Evento sin texto o remitente (ignorado)");
      return res.sendStatus(200);
    }

    const text = message.text.body.toLowerCase().trim();
    const from = message.from;

    console.log("✅ Texto extraído:", text);
    console.log("✅ From extraído:", from);

    // Inicializar sesión
    if (!sessions[from]) {
      sessions[from] = { step: "menu" };
    }

    // Reset al menú
    if (text === "menu" || text === "menú") {
      sessions[from].step = "menu";
    }

    let reply = "";

    // Flujo del bot
    if (sessions[from].step === "menu") {
      reply = `👋 ¡Bienvenido a nuestra empresa!

¿En qué podemos ayudarte hoy?

1️⃣ Soporte técnico
2️⃣ Ventas
3️⃣ Hablar con un asesor

💬 Responde con el número de tu opción`;
      sessions[from].step = "option";
    } else if (sessions[from].step === "option") {
      if (text === "1") {
        reply = `🛠️ *Soporte Técnico*

Aquí puedes encontrar soluciones a tus problemas:
👉 https://tuapp.com/soporte

💡 Escribe *menu* para volver al inicio.`;
        sessions[from].step = "menu";
      } else if (text === "2") {
        reply = `💰 *Ventas*

Conoce nuestros productos y servicios:
👉 https://tuapp.com/ventas

💡 Escribe *menu* para volver al inicio.`;
        sessions[from].step = "menu";
      } else if (text === "3") {
        reply = `👤 *Asesor Humano*

Un asesor se comunicará contigo pronto.
⏰ L–V 9am–6pm

💡 Escribe *menu* para volver al inicio.`;
        sessions[from].step = "menu";
      } else {
        reply = `❌ Opción no válida

Responde:
1️⃣ Soporte
2️⃣ Ventas
3️⃣ Asesor

O escribe *menu* para reiniciar`;
      }
    }

    console.log("📤 Enviando respuesta a WhatsApp:", reply);

    // 👉 ENVÍO REAL DEL MENSAJE A WHATSAPP (ESTA ES LA CLAVE)
    await axios.post(
      "https://api.gupshup.io/wa/api/v1/msg",
      new URLSearchParams({
        channel: "whatsapp",
        source: process.env.GS_SOURCE_NUMBER,
        destination: from,
        message: reply,
        appname: process.env.GUPSHUP_APP_NAME,
      }),
      {
        headers: {
          apikey: process.env.GUPSHUP_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    // Responder SOLO OK al webhook
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERROR:", err.response?.data || err.message);
    res.sendStatus(200);
  }
});

// Verificación
app.get("/webhook", (req, res) => {
  res.send("Webhook activo ✅");
});

app.get("/", (req, res) => {
  res.send("🤖 Bot WhatsApp activo 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
});
