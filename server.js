require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====================
// Estados de sesión
// ====================
const STATES = {
  BOT: "bot",
  WITH_AGENT: "with_agent",
};

const sessions = {};

// Plataforma de agentes
const PLATFORM_WEBHOOK_URL =
  "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook";

// ====================
// WEBHOOK PRINCIPAL
// ====================
app.post("/webhook", async (req, res) => {
  try {
    console.log("========================================");
    console.log("📥 WEBHOOK RECIBIDO");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("========================================");

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message || !message.from) {
      return res.sendStatus(200);
    }

    const from = message.from;
    let text = "";

    // ====================
    // EXTRAER TEXTO
    // ====================
    if (message.text?.body) {
      text = message.text.body.toLowerCase().trim();
    }

    // ====================
    // NORMALIZAR BOTONES (CLAVE)
    // ====================
    if (text.includes("soporte")) text = "btn_soporte";
    else if (text.includes("ventas")) text = "btn_ventas";
    else if (text.includes("asesor")) text = "btn_asesor";

    console.log("➡️ From:", from);
    console.log("➡️ Text normalizado:", text);

    // ====================
    // INICIALIZAR SESIÓN
    // ====================
    if (!sessions[from]) {
      sessions[from] = { step: "menu", state: STATES.BOT };
    }

    // ================================
    // 🔄 MODO AGENTE
    // ================================
    if (sessions[from].state === STATES.WITH_AGENT) {
      try {
        await axios.post(PLATFORM_WEBHOOK_URL, req.body, {
          headers: { "Content-Type": "application/json" },
          timeout: 5000,
        });
        return res.sendStatus(200);
      } catch {
        await sendText(
          from,
          "⚠️ Problema con soporte.\n\nEscribe *menu* para volver."
        );
        sessions[from] = { step: "menu", state: STATES.BOT };
        return res.sendStatus(200);
      }
    }

    // ====================
    // RESET A MENÚ
    // ====================
    if (text === "menu" || text === "menú") {
      sessions[from] = { step: "menu", state: STATES.BOT };
    }

    // ====================
    // SOPORTE
    // ====================
    if (text === "btn_soporte") {
      sessions[from].state = STATES.WITH_AGENT;

      await sendText(
        from,
        "🛠️ *Conectando con Soporte*\n\n✍️ Escribe tu mensaje."
      );

      try {
        await axios.post(PLATFORM_WEBHOOK_URL, {
          event: "conversation_started",
          from,
          timestamp: new Date().toISOString(),
        });
      } catch {
        await sendText(
          from,
          "⚠️ No hay agentes disponibles.\n\nEscribe *menu* para volver."
        );
        sessions[from] = { step: "menu", state: STATES.BOT };
      }

      return res.sendStatus(200);
    }

    // ====================
    // MENÚ
    // ====================
    if (sessions[from].step === "menu") {
      await sendQuickMenu(from);
      sessions[from].step = "option";
      return res.sendStatus(200);
    }

    // ====================
    // OPCIONES
    // ====================
    if (sessions[from].step === "option") {
      if (text === "btn_ventas") {
        await sendText(
          from,
          "💰 *Ventas*\n👉 https://tuapp.com/ventas\n\nEscribe *menu*"
        );
        sessions[from].step = "menu";
        return res.sendStatus(200);
      }

      if (text === "btn_asesor") {
        await sendText(
          from,
          "👤 *Asesor humano*\n⏰ L–V 9am–6pm\n\nEscribe *menu*"
        );
        sessions[from].step = "menu";
        return res.sendStatus(200);
      }

      await sendText(from, "❌ Opción no válida.\nEscribe *menu*");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    res.sendStatus(200);
  }
});

// ====================
// HELPERS
// ====================
async function sendText(to, text) {
  const params = new URLSearchParams({
    channel: "whatsapp",
    source: process.env.GS_SOURCE_NUMBER,
    destination: to,
    message: JSON.stringify({ type: "text", text }),
    "src.name": process.env.GUPSHUP_APP_NAME,
  });

  await axios.post("https://api.gupshup.io/wa/api/v1/msg", params, {
    headers: {
      apikey: process.env.GUPSHUP_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
}

async function sendQuickMenu(to) {
  const payload = {
    type: "quick_reply",
    content: {
      type: "text",
      text: "👋 ¡Bienvenido!\n¿En qué podemos ayudarte?",
    },
    options: [
      { type: "text", title: "🛠️ Soporte" },
      { type: "text", title: "💰 Ventas" },
      { type: "text", title: "👤 Asesor" },
    ],
  };

  const params = new URLSearchParams({
    channel: "whatsapp",
    source: process.env.GS_SOURCE_NUMBER,
    destination: to,
    message: JSON.stringify(payload),
    "src.name": process.env.GUPSHUP_APP_NAME,
  });

  await axios.post("https://api.gupshup.io/wa/api/v1/msg", params, {
    headers: {
      apikey: process.env.GUPSHUP_API_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
}

// ====================
app.get("/webhook", (_, res) => res.send("Webhook activo ✅"));
app.get("/", (_, res) => res.send("🤖 Bot activo"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});
