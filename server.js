require("dotenv").config();
const express = require("express");
const flow = require("./bot");

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

    // 👉 BUSCAR RESPUESTA EN EL FLOW
    const answer = await flow.find(text, { from });

    if (!answer) {
      return res.json({ reply: 'Escribe "menu" para iniciar' });
    }

    res.json({
      reply: answer.answer,
    });
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
