require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Memoria simple por usuario
const sessions = {};

app.post("/webhook", async (req, res) => {
  try {
    // 🔍 Log completo para debug
    console.log("========================================");
    console.log("📩 WEBHOOK RECIBIDO:");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("========================================");

    // 📝 Extraer datos según el formato de Gupshup (Meta v3)
    // Gupshup puede enviar en diferentes formatos, intentamos todos
    const text = (
      req.body.payload?.text || // Formato Meta v3
      req.body.payload?.payload?.text || // Formato anidado
      req.body.message?.text || // Formato alternativo
      req.body.text || // Formato simple
      ""
    )
      .toLowerCase()
      .trim();

    const from =
      req.body.payload?.sender || // Formato Meta v3
      req.body.payload?.source || // Formato alternativo
      req.body.sender?.phone || // Tu formato
      req.body.sender || // Formato simple
      req.body.from || // Otro formato
      "";

    console.log("✅ Texto extraído:", text);
    console.log("✅ From extraído:", from);

    // Si no hay datos válidos, responder OK para evitar reintentos
    if (!text || !from) {
      console.log("⚠️ Mensaje sin texto o remitente válido");
      return res.status(200).json({ status: "ok" });
    }

    let reply = "";

    // Inicializar sesión si no existe
    if (!sessions[from]) {
      sessions[from] = { step: "menu" };
    }

    // Permitir que el usuario escriba "menu" en cualquier momento
    if (text === "menu" || text === "menú") {
      sessions[from].step = "menu";
    }

    // Flujo del chatbot
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

💡 Si necesitas más ayuda, escribe *menu* para volver al inicio.`;
        sessions[from].step = "menu";
      } else if (text === "2") {
        reply = `💰 *Ventas*

Conoce nuestros productos y servicios:

👉 https://tuapp.com/ventas

💡 Escribe *menu* para volver al inicio.`;
        sessions[from].step = "menu";
      } else if (text === "3") {
        reply = `👤 *Asesor Humano*

Perfecto, un asesor se comunicará contigo en breve.

⏰ Horario de atención: Lunes a Viernes, 9am - 6pm

💡 Escribe *menu* para volver al inicio.`;
        sessions[from].step = "menu";
      } else {
        reply = `❌ Opción no válida

Por favor responde con:
1️⃣ para Soporte
2️⃣ para Ventas  
3️⃣ para Asesor

O escribe *menu* para reiniciar`;
        // NO cambiamos el step, seguimos esperando una opción válida
      }
    }

    console.log("📤 Respuesta enviada:", reply);

    // Responder en el formato que espera Gupshup
    res.status(200).json({
      text: reply,
    });
  } catch (err) {
    console.error("❌ ERROR:", err);
    // Siempre responder 200 para evitar reintentos
    res.status(200).json({ status: "error" });
  }
});

// Ruta GET para verificación del webhook
app.get("/webhook", (req, res) => {
  console.log("✅ Verificación GET del webhook");
  res.status(200).send("Webhook funcionando correctamente ✅");
});

// Ruta raíz
app.get("/", (req, res) => {
  res.send("🤖 Bot de WhatsApp activo 🚀");
});

// Puerto dinámico para Render
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en puerto ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
});
