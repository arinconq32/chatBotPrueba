require("dotenv").config();
const express = require("express");
const { handleMessage } = require("@builderbot/bot");
const { flow } = require("./bot");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/webhook", async (req, res) => {
  try {
    console.log("BODY:", req.body);

    const text = req.body.message;
    const from = req.body.sender;

    if (!text || !from) {
      return res.sendStatus(200);
    }

    const response = await handleMessage({
      body: text,
      from,
      flow,
    });

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
