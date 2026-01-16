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

// URL de tu plataforma de agentes
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
      console.log("⚠️ Evento sin mensaje o remitente");
      return res.sendStatus(200);
    }

    const from = message.from;
    let text = "";

    // ====================
    // Extraer texto / botón
    // ====================
    if (message.text?.body) {
      text = message.text.body.toLowerCase().trim();
    } else if (message.type === "interactive") {
      const btn =
        message.interactive?.button_reply || message.interactive?.list_reply;
      if (btn?.id) text = btn.id;
    }

    console.log("➡️ From:", from);
    console.log("➡️ Text:", text);

    // ====================
    // Inicializar sesión
    // ====================
    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        state: STATES.BOT,
      };
    }

    // ================================
    // 🔄 MODO AGENTE → reenviar TODO
    // ================================
    if (sessions[from].state === STATES.WITH_AGENT) {
      console.log("🔄 Reenviando mensaje a plataforma");

      try {
        await axios.post(PLATFORM_WEBHOOK_URL, req.body, {
          headers: { "Content-Type": "application/json" },
          timeout: 5000,
        });

        return res.sendStatus(200);
      } catch (err) {
        console.error("❌ Error plataforma:", err.message);

        await sendText(
          from,
          "⚠️ Problema de conexión con soporte.\n\nEscribe *menu* para volver."
        );

        sessions[from].state = STATES.BOT;
        sessions[from].step = "menu";

        return res.sendStatus(200);
      }
    }

    // ====================
    // Reset manual a menú
    // ====================
    if (text === "menu" || text === "menú") {
      sessions[from].state = STATES.BOT;
      sessions[from].step = "menu";
    }

    // ====================
    // 🛠️ SOPORTE (ANTES DEL MENÚ)
    // ====================
    if (text === "btn_soporte") {
      sessions[from].state = STATES.WITH_AGENT;
      sessions[from].step = "agent";

      await sendText(
        from,
        "🛠️ *Conectando con Soporte*\n\n✍️ Escribe tu mensaje y un agente te atenderá."
      );

      let agentAvailable = true;

      try {
        await axios.post(
          PLATFORM_WEBHOOK_URL,
          {
            event: "conversation_started",
            from,
            timestamp: new Date().toISOString(),
          },
          { timeout: 10000 }
        );
      } catch {
        agentAvailable = false;
      }

      if (!agentAvailable) {
        await sendText(
          from,
          "⚠️ *No hay agentes disponibles*\n\nEscribe *menu* para volver."
        );
        sessions[from].state = STATES.BOT;
        sessions[from].step = "menu";
      }

      return res.sendStatus(200); // 🔴 CLAVE
    }

    // ====================
    // MENÚ PRINCIPAL
    // ====================
    if (sessions[from].step === "menu" && !text) {
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
          "💰 *Ventas*\n👉 https://tuapp.com/ventas\n\nEscribe *menu* para volver."
        );
        sessions[from].step = "menu";
        return res.sendStatus(200);
      }

      if (text === "btn_asesor") {
        await sendText(
          from,
          "👤 *Asesor humano*\n⏰ L–V 9am–6pm\n\nEscribe *menu* para volver."
        );
        sessions[from].step = "menu";
        return res.sendStatus(200);
      }

      await sendText(from, "❌ Opción no válida.\nEscribe *menu*");
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ ERROR GENERAL:", err.message);
    res.sendStatus(200);
  }
});

// ====================
// HELPERS
// ====================
async function sendText(to, text) {
  const payload = {
    type: "text",
    text,
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

async function sendQuickMenu(to) {
  const payload = {
    type: "quick_reply",
    content: {
      type: "text",
      text: "👋 ¡Bienvenido!\n¿En qué podemos ayudarte?",
    },
    options: [
      { type: "text", title: "🛠️ Soporte", postbackText: "btn_soporte" },
      { type: "text", title: "💰 Ventas", postbackText: "btn_ventas" },
      { type: "text", title: "👤 Asesor", postbackText: "btn_asesor" },
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
// ENDPOINTS
// ====================
app.get("/webhook", (_, res) => res.send("Webhook activo ✅"));
app.get("/", (_, res) => res.send("🤖 Bot activo"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});
