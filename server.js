require("dotenv").config();
const express = require("express");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// memoria simple por usuario (demo)
const sessions = {};

app.post("/webhook", async (req, res) => {
  try {
    console.log("BODY:", req.body);

    const text = req.body.message?.toLowerCase();
    const from = req.body.sender;

    if (!text || !from) {
      return res.sendStatus(200);
    }

    let reply = "";

    if (!sessions[from]) {
      sessions[from] = { step: "menu" };
    }

    if (sessions[from].step === "menu") {
      reply = `👋 Bienvenido a la empresa

1️⃣ Soporte
2️⃣ Ventas
3️⃣ Asesor humano

Responde con el número`;
      sessions[from].step = "option";
    } else if (sessions[from].step === "option") {
      if (text === "1") {
        reply = "🛠️ Soporte técnico:\n👉 https://tuapp.com/soporte";
      } else if (text === "2") {
        reply = "💰 Ventas:\n👉 https://tuapp.com/ventas";
      } else if (text === "3") {
        reply = "👤 Te contactará un asesor";
      } else {
        reply = "❌ Opción no válida. Escribe 1, 2 o 3.";
        return res.json({ reply });
      }
      sessions[from].step = "menu";
    }

    res.json({ reply });
  } catch (err) {
    console.error("ERROR:", err);
    res.sendStatus(200);
  }
});

app.get("/", (_, res) => {
  res.send("Bot activo 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor en puerto ${PORT}`);
});
