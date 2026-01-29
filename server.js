require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Estados de la conversación
const STATES = {
  BOT: "bot",
  CONNECTING: "connecting",
  WITH_AGENT: "with_agent",
};

const sessions = {};
const MAX_CONCURRENT_CLIENTS = 3;

// Helper para contar clientes activos con agentes
function getActiveClientsCount() {
  return Object.values(sessions).filter(
    (s) => s.state === STATES.WITH_AGENT || s.state === STATES.CONNECTING,
  ).length;
}

// Helper para enviar mensajes a Gupshup
async function sendGupshupMessage(destination, payload) {
  const params = new URLSearchParams({
    channel: "whatsapp",
    source: process.env.GS_SOURCE_NUMBER || "919999900095",
    destination: destination,
    message: JSON.stringify(payload),
    "src.name": process.env.GUPSHUP_APP_NAME || "chatbotPruebas32",
  });

  try {
    const response = await axios.post(
      "https://api.gupshup.io/wa/api/v1/msg",
      params.toString(),
      {
        headers: {
          apikey: process.env.GUPSHUP_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache",
        },
      },
    );
    console.log(`✅ Mensaje enviado a ${destination}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error enviando mensaje a ${destination}:`, error.message);
    throw error;
  }
}

// Helper para descargar medios desde Gupshup
async function downloadMediaFromGupshup(mediaId, from) {
  try {
    const response = await axios.get(
      `https://api.gupshup.io/wa/api/v1/media/${mediaId}`,
      {
        headers: {
          apikey: process.env.GUPSHUP_API_KEY,
        },
        responseType: "arraybuffer",
      },
    );

    const contentType = response.headers["content-type"];
    const buffer = Buffer.from(response.data);

    return {
      buffer: buffer,
      contentType: contentType,
      size: buffer.length,
    };
  } catch (error) {
    console.error(
      `❌ Error descargando media ${mediaId} de ${from}:`,
      error.message,
    );
    throw error;
  }
}

// Función para enviar mensaje de agente disponible solo a una sala específica
async function notifyAgentAvailableToRoom(numeroAgente, from, io) {
  const idSala = `${numeroAgente}-${from}`;

  console.log(`📢 Notificando disponibilidad de agente a sala: ${idSala}`);

  io.to(idSala).emit("agent_available", {
    numeroAgente: numeroAgente,
    convId: from,
    timestamp: Date.now(),
  });
}

app.post("/webhook", async (req, res) => {
  const data = req.body;

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message || !message.from) {
      return res.sendStatus(200);
    }

    const from = message.from;
    let text = "";
    let mediaInfo = null;
    let messageType = "text";

    // Detectar tipo de mensaje y extraer contenido
    switch (message.type) {
      case "text":
        text = message.text.body.toLowerCase().trim();
        messageType = "text";
        console.log(`📨 Mensaje de texto recibido de ${from}: "${text}"`);
        break;

      case "image":
        messageType = "image";
        mediaInfo = {
          id: message.image.id,
          caption: message.image.caption || "",
          mime_type: message.image.mime_type || "image/jpeg",
        };
        console.log(`🖼️ Imagen recibida de ${from}, ID: ${mediaInfo.id}`);
        text = mediaInfo.caption.toLowerCase().trim();
        break;

      case "video":
        messageType = "video";
        mediaInfo = {
          id: message.video.id,
          caption: message.video.caption || "",
          mime_type: message.video.mime_type || "video/mp4",
        };
        console.log(`🎥 Video recibido de ${from}, ID: ${mediaInfo.id}`);
        text = mediaInfo.caption.toLowerCase().trim();
        break;

      case "audio":
        messageType = "audio";
        mediaInfo = {
          id: message.audio.id,
          mime_type: message.audio.mime_type || "audio/ogg",
        };
        console.log(`🎵 Audio recibido de ${from}, ID: ${mediaInfo.id}`);
        break;

      case "document":
        messageType = "document";
        mediaInfo = {
          id: message.document.id,
          filename: message.document.filename || "document",
          mime_type: message.document.mime_type || "application/octet-stream",
          caption: message.document.caption || "",
        };
        console.log(
          `📄 Documento recibido de ${from}, ID: ${mediaInfo.id}, Nombre: ${mediaInfo.filename}`,
        );
        text = mediaInfo.caption.toLowerCase().trim();
        break;

      case "interactive":
        const interactive = message.interactive;
        const reply = interactive.button_reply || interactive.list_reply;
        if (reply) {
          try {
            const replyData = JSON.parse(reply.id);
            text = replyData.postbackText;
          } catch (e) {
            text = reply.id;
          }
        }
        messageType = "interactive";
        console.log(`🔘 Interactivo recibido de ${from}: "${text}"`);
        break;

      default:
        console.log(
          `❓ Tipo de mensaje no manejado de ${from}: ${message.type}`,
        );
        return res.sendStatus(200);
    }

    // Inicializar sesión
    if (!sessions[from]) {
      sessions[from] = { step: "menu", state: STATES.BOT };
      console.log(`👤 Nueva sesión creada para ${from}`);
    }

    // Si ya está con un agente, reenviar mensaje (con medios) a la plataforma externa
    if (sessions[from].state === STATES.WITH_AGENT) {
      const numeroAgente = sessions[from].numeroAgente;
      const idSala = `${numeroAgente}-${from}`;
      console.log(
        `📤 Reenviando mensaje de ${from} al agente ${numeroAgente}...`,
      );

      // Enviar via Socket.io si está disponible
      if (global.io) {
        global.io.to(idSala).emit("chat_message", {
          convId: from,
          msg: {
            id: Date.now(),
            emisor: "contacto",
            mensaje: text || "",
            tipo: messageType,
            timestamp: Date.now(),
            origen: "whatsapp",
          },
        });
      }

      // Preparar payload para enviar al webhook externo
      let payloadToSupport = {
        from,
        text: text || "",
        type: "incoming_message",
        message_type: messageType,
        timestamp: new Date().toISOString(),
        object: "whatsapp_business_account",
        numeroAgente: numeroAgente,
      };

      // Si hay medios, descargarlos y enviarlos
      if (mediaInfo) {
        try {
          console.log(`⬇️ Descargando media de ${from}...`);
          const mediaData = await downloadMediaFromGupshup(mediaInfo.id, from);

          payloadToSupport.media = {
            ...mediaInfo,
            buffer: mediaData.buffer.toString("base64"),
            content_type: mediaData.contentType,
            size: mediaData.size,
          };

          console.log(
            `✅ Media descargado de ${from}: ${mediaData.size} bytes, tipo: ${mediaData.contentType}`,
          );
        } catch (mediaError) {
          console.error(
            `❌ Error procesando media de ${from}:`,
            mediaError.message,
          );
          payloadToSupport.media_error = mediaError.message;
        }
      }

      try {
        await axios.post(
          "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook",
          payloadToSupport,
          { timeout: 10000 },
        );
      } catch (e) {
        console.error("❌ Error reenviando al soporte:", e.message);
      }
      return res.sendStatus(200);
    }

    // Si está conectando, ignorar mensajes hasta que termine
    if (sessions[from].state === STATES.CONNECTING) {
      console.log(
        `⏳ Usuario ${from} está en proceso de conexión, ignorando mensaje`,
      );

      if (messageType !== "text") {
        const connectingPayload = {
          type: "text",
          text: "⏳ *Espera un momento*\n\nEstamos conectándote con un agente. Por favor espera a que se complete la conexión antes de enviar archivos.",
        };
        await sendGupshupMessage(from, connectingPayload);
      }

      return res.sendStatus(200);
    }

    // ✅ MANEJO DEL COMANDO "MENU" - NO SE ENVÍA AL APLICATIVO
    if (text === "menu" || text === "menú") {
      console.log(
        `🔄 Usuario ${from} solicitó el menú - gestionado localmente`,
      );
      sessions[from].step = "menu";
      sessions[from].state = STATES.BOT;

      const menuPayload = {
        type: "quick_reply",
        msgid: "menu_principal",
        content: {
          type: "text",
          text: "👋 ¡Bienvenido!\n\n¿En qué podemos ayudarte hoy?",
        },
        options: [
          { type: "text", title: "🛠️ Soporte", postbackText: "btn_soporte" },
          { type: "text", title: "💰 Ventas", postbackText: "btn_ventas" },
        ],
      };

      await sendGupshupMessage(from, menuPayload);
      return res.sendStatus(200);
    }

    let messagePayload = null;

    // FLUJO DEL BOT - MENÚ PRINCIPAL
    if (sessions[from].step === "menu") {
      if (messageType !== "text" && messageType !== "interactive") {
        console.log(
          `⚠️ Usuario ${from} envió ${messageType} en el menú principal`,
        );
        messagePayload = {
          type: "text",
          text: `📎 *Archivo recibido*\n\nPara enviar archivos necesitas estar conectado con un agente.\n\nSelecciona *"🛠️ Soporte"* para hablar con un agente y luego podrás enviar imágenes, videos, audios y documentos.`,
        };

        await sendGupshupMessage(from, messagePayload);
        await new Promise((resolve) => setTimeout(resolve, 500));

        const menuPayload = {
          type: "quick_reply",
          msgid: "menu_principal",
          content: {
            type: "text",
            text: "👋 ¡Bienvenido!\n\n¿En qué podemos ayudarte hoy?",
          },
          options: [
            { type: "text", title: "🛠️ Soporte", postbackText: "btn_soporte" },
            { type: "text", title: "💰 Ventas", postbackText: "btn_ventas" },
          ],
        };

        await sendGupshupMessage(from, menuPayload);
        return res.sendStatus(200);
      }

      console.log(`📋 Mostrando menú principal a ${from}`);
      messagePayload = {
        type: "quick_reply",
        msgid: "menu_principal",
        content: {
          type: "text",
          text: "👋 ¡Bienvenido!\n\n¿En qué podemos ayudarte hoy?",
        },
        options: [
          { type: "text", title: "🛠️ Soporte", postbackText: "btn_soporte" },
          { type: "text", title: "💰 Ventas", postbackText: "btn_ventas" },
        ],
      };
      sessions[from].step = "option";
    }
    // FLUJO DEL BOT - OPCIONES
    else if (sessions[from].step === "option") {
      if (messageType !== "text" && messageType !== "interactive") {
        console.log(
          `⚠️ Usuario ${from} envió ${messageType} en lugar de seleccionar opción`,
        );
        messagePayload = {
          type: "text",
          text: `📎 *Archivo recibido*\n\nPor favor selecciona una opción del menú primero.\n\nEnvía *menu* para volver al menú principal.`,
        };

        await sendGupshupMessage(from, messagePayload);
        return res.sendStatus(200);
      }

      // ✅ MANEJO DE SOLICITUD DE SOPORTE (botón o texto "soporte")
      if (text === "btn_soporte" || text === "soporte") {
        console.log(`🛠️ Usuario ${from} solicita soporte...`);

        // Verificar límite de clientes concurrentes
        const activeClients = getActiveClientsCount();
        if (activeClients >= MAX_CONCURRENT_CLIENTS) {
          console.log(
            `⚠️ Límite alcanzado: ${activeClients}/${MAX_CONCURRENT_CLIENTS} clientes activos`,
          );

          const limitPayload = {
            type: "text",
            text: `🛠️ *Soporte Técnico*\n\n⏳ Actualmente tenemos ${MAX_CONCURRENT_CLIENTS} conversaciones activas.\n\n💡 Por favor intenta nuevamente en unos minutos.\n\nEscribe *menu* para ver otras opciones.`,
          };

          await sendGupshupMessage(from, limitPayload);
          sessions[from].step = "menu";
          return res.sendStatus(200);
        }

        sessions[from].state = STATES.CONNECTING;

        // ✅ AQUÍ SÍ ENVIAMOS AL APLICATIVO (solo cuando pide soporte)
        try {
          await axios.post(
            "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook",
            {
              from: from,
              text: "soporte",
              type: "incoming_message",
              object: "whatsapp_business_account",
              cola: "PRUEBAS",
              pausa: 1,
            },
            { timeout: 5000 },
          );
          console.log(
            `✅ Solicitud de soporte enviada al aplicativo para ${from}`,
          );
        } catch (e) {
          console.error(
            "⚠️ Error enviando solicitud al aplicativo:",
            e.message,
          );
        }

        // Mensaje de conexión en progreso
        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        };

        await sendGupshupMessage(from, messagePayload);
        console.log(`📤 Mensaje de conexión enviado a ${from}`);

        // Intentar conexión al webhook externo
        console.log(
          `--- Intentando conectar ${from} con soporte (10s timeout) ---`,
        );

        try {
          const response = await axios.post(
            "https://sabrina-agglutinable-maynard.ngrok-free.dev/webhook",
            {
              from: from,
              text: "soporte",
              type: "incoming_message",
              event: "support_requested",
              object: "whatsapp_business_account",
              timestamp: new Date().toISOString(),
              cola: "PRUEBAS",
              pausa: 1,
            },
            { timeout: 10000 },
          );

          // Extraer número de agente de la respuesta (ajusta según tu API)
          const numeroAgente = response.data?.numeroAgente || "default";

          console.log(`✅ Agente ${numeroAgente} conectado para ${from}`);

          sessions[from].state = STATES.WITH_AGENT;
          sessions[from].numeroAgente = numeroAgente;

          // ✅ Notificar disponibilidad solo a la sala específica
          if (global.io) {
            notifyAgentAvailableToRoom(numeroAgente, from, global.io);
          }

          const successPayload = {
            type: "text",
            text: "🛠️ *Soporte Conectado*\n\n✅ Un agente está listo para ayudarte.\n\n📎 *Ahora puedes enviar:*\n• Imágenes 📷\n• Videos 🎥\n• Audios 🎵\n• Documentos 📄\n\n_Escribe tu mensaje o envía archivos directamente._",
          };

          await sendGupshupMessage(from, successPayload);
          console.log(`✅ Mensaje de éxito enviado a ${from}`);
        } catch (error) {
          const errorType =
            error.code === "ECONNABORTED" ? "Timeout (>10s)" : error.message;
          console.log(`❌ Soporte no disponible para ${from}: ${errorType}`);

          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";

          const failurePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n❌ Lo sentimos, en este momento no hay agentes disponibles.\n\n💡 Escribe *menu* para intentar más tarde o elige otra opción.",
          };

          await sendGupshupMessage(from, failurePayload);
          console.log(`❌ Mensaje de error enviado a ${from}`);
        }

        return res.sendStatus(200);
      } else if (text === "btn_ventas") {
        console.log(`💰 Usuario ${from} solicita información de ventas`);
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nVisita nuestra web: https://tuapp.com/ventas\n\nEscribe *menu* para volver.",
        };
        sessions[from].step = "menu";
      } else {
        console.log(`⚠️ Entrada inválida de ${from}: "${text}"`);
        messagePayload = {
          type: "text",
          text: "❌ No entendí tu respuesta.\n\nEscribe *menu* para ver las opciones disponibles.",
        };
      }
    }

    // Enviar respuesta final si existe un payload
    if (messagePayload) {
      console.log(
        `📨 Enviando payload a ${from}:`,
        JSON.stringify(messagePayload),
      );
      await sendGupshupMessage(from, messagePayload);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error en Webhook:", err.message);
    res.sendStatus(200);
  }
});

// Endpoint para recibir confirmaciones de entrega/lectura
app.post("/webhook/status", (req, res) => {
  console.log("📊 Status update:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// Endpoint para liberar una sesión cuando un agente termina la conversación
app.post("/webhook/end-session", (req, res) => {
  const { from } = req.body;

  if (sessions[from]) {
    console.log(`🔚 Finalizando sesión de ${from}`);
    sessions[from].state = STATES.BOT;
    sessions[from].step = "menu";
    delete sessions[from].numeroAgente;
  }

  res.sendStatus(200);
});

// Endpoint para obtener estadísticas
app.get("/stats", (req, res) => {
  const activeClients = getActiveClientsCount();
  const totalSessions = Object.keys(sessions).length;

  res.json({
    activeClients,
    maxClients: MAX_CONCURRENT_CLIENTS,
    availableSlots: MAX_CONCURRENT_CLIENTS - activeClients,
    totalSessions,
    sessions: Object.keys(sessions).map((key) => ({
      from: key,
      state: sessions[key].state,
      step: sessions[key].step,
      numeroAgente: sessions[key].numeroAgente || null,
    })),
  });
});

app.get("/", (req, res) => res.send("Bot Online 🚀"));

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () =>
  console.log(`🚀 Servidor en puerto ${PORT}`),
);

// Configurar Socket.io si es necesario
const http = require("http");
const socketIo = require("socket.io");

const httpServer = http.createServer(app);
const io = socketIo(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

global.io = io;

io.on("connection", (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  socket.on("join_room", ({ numeroAgente, convId }) => {
    const idSala = `${numeroAgente}-${convId}`;
    socket.join(idSala);
    console.log(`✅ Socket ${socket.id} unido a sala: ${idSala}`);
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Cliente desconectado: ${socket.id}`);
  });
});

httpServer.listen(PORT + 1, () => {
  console.log(`🔌 Socket.io escuchando en puerto ${PORT + 1}`);
});
