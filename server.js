require("dotenv").config();
const express = require("express");
const { handleMessage } = require("@builderbot/bot");
const { flow } = require("./bot");

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  try {
    const text = req.body.message?.text;
    const from = req.body.sender?.phone;

    if (!text || !from) {
      return res.sendStatus(200);
    }

    const response = await handleMessage({
      body: text,
      from,
      flow,
    });

    // Respuesta para Gupshup
    res.json({
      reply: response?.answer || 'Escribe "menu" para iniciar',
    });
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

app.get("/webhook", (req, res) => {
  res.status(200).send("Webhook funcionando correctamente ✅");
});

app.get("/", (_, res) => {
  res.send("Bot activo 🚀");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
