const { addKeyword } = require("@builderbot/bot");

const flowMenu = addKeyword(["hola", "menu", "inicio"]).addAnswer(
  `👋 Bienvenido a la empresa

1️⃣ Soporte
2️⃣ Ventas
3️⃣ Asesor humano

Responde con el número`
);

const flowSoporte = addKeyword(["1"])
  .addAnswer("🛠️ Te redirigimos a soporte técnico")
  .addAnswer("👉 https://tuapp.com/chat-soporte");

const flowVentas = addKeyword(["2"])
  .addAnswer("💰 Ventas")
  .addAnswer("👉 https://tuapp.com/chat-ventas");

module.exports = { flowMenu, flowSoporte, flowVentas };
