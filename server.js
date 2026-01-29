require("dotenv").config();
const express = require("express");
const axios = require("axios");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function extractNumberFromMessage(text) {
  // Captura el último bloque de dígitos que venga después de un guion
  const match = text.match(/-\s*(\d+)\s*$/);
  return match ? match[1] : null;
}

// Estados de la conversación
const STATES = {
  BOT: "bot",
  CONNECTING: "connecting",
  WITH_AGENT: "with_agent",
};

// Estructuras de datos
const sessions = {}; // { from: { step, state, numeroAgente, idSala } }
const availableNumbers = []; // Cola de números disponibles
const agentConnections = {}; // { numeroAgente: [idSala1, idSala2, idSala3] }
const roomConnections = {}; // { idSala: { agente: numeroAgente, cliente: from } }

// Constantes
const MAX_CONNECTIONS_PER_AGENT = 3;

// Función para obtener el siguiente número disponible
function getNextAvailableNumber() {
  // Buscar un agente que tenga menos de 3 conexiones
  for (const numero of availableNumbers) {
    const connections = agentConnections[numero] || [];
    if (connections.length < MAX_CONNECTIONS_PER_AGENT) {
      return numero;
    }
  }
  return null; // No hay agentes disponibles
}

// Función para agregar conexión a un agente
function addAgentConnection(numeroAgente, idSala) {
  if (!agentConnections[numeroAgente]) {
    agentConnections[numeroAgente] = [];
  }

  if (agentConnections[numeroAgente].length < MAX_CONNECTIONS_PER_AGENT) {
    agentConnections[numeroAgente].push(idSala);
    return true;
  }
  return false;
}

// Función para remover conexión de un agente
function removeAgentConnection(numeroAgente, idSala) {
  if (agentConnections[numeroAgente]) {
    agentConnections[numeroAgente] = agentConnections[numeroAgente].filter(
      (sala) => sala !== idSala,
    );

    // Si el agente quedó sin conexiones y no está en availableNumbers, agregarlo
    if (agentConnections[numeroAgente].length === 0) {
      delete agentConnections[numeroAgente];
    }
  }
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

// Socket.IO - Manejo de conexiones
io.on("connection", (socket) => {
  console.log(`🔌 Cliente conectado: ${socket.id}`);

  // Cuando un agente se registra
  socket.on("register_agent", (data) => {
    const { numeroAgente } = data;
    console.log(`👨‍💼 Agente registrado: ${numeroAgente}`);

    // Agregar el número a la lista de disponibles si no existe
    if (!availableNumbers.includes(numeroAgente)) {
      availableNumbers.push(numeroAgente);
      console.log(`✅ Agente ${numeroAgente} agregado a disponibles`);
    }
  });

  // Cuando un agente se une a una sala
  socket.on("join_room", (data) => {
    const { idSala, numeroAgente } = data;

    // Verificar que la sala existe y está esperando al agente
    if (!roomConnections[idSala]) {
      console.error(`❌ Sala ${idSala} no existe o ya fue cerrada`);
      socket.emit("error", { message: "Sala no encontrada" });
      return;
    }

    // Verificar que el agente tiene capacidad
    const connections = agentConnections[numeroAgente] || [];
    if (connections.length >= MAX_CONNECTIONS_PER_AGENT) {
      console.error(
        `❌ Agente ${numeroAgente} alcanzó el límite de ${MAX_CONNECTIONS_PER_AGENT} conexiones`,
      );
      socket.emit("error", { message: "Límite de conexiones alcanzado" });
      return;
    }

    // Marcar la sala como "conectada" (agente activo)
    roomConnections[idSala].agenteConectado = true;
    roomConnections[idSala].socketId = socket.id;

    // Unir el socket del agente a la sala
    socket.join(idSala);
    console.log(
      `🚪 Agente ${numeroAgente} se unió a sala ${idSala} (${connections.length + 1}/${MAX_CONNECTIONS_PER_AGENT})`,
    );

    // Actualizar la sesión del cliente a WITH_AGENT
    const { cliente } = roomConnections[idSala];
    if (sessions[cliente]) {
      sessions[cliente].state = STATES.WITH_AGENT;
      console.log(
        `✅ Cliente ${cliente} ahora puede comunicarse con agente en sala ${idSala}`,
      );

      // Notificar al cliente que el agente está listo
      sendGupshupMessage(cliente, {
        type: "text",
        text: `🛠️ *Agente Conectado*\n\n✅ El agente #${numeroAgente} está ahora en línea y listo para ayudarte.\n\n📎 Puedes escribir tu mensaje o enviar archivos.`,
      }).catch((err) =>
        console.error(`❌ Error notificando conexión a cliente:`, err.message),
      );
    }

    // Confirmar al agente que se unió exitosamente
    socket.emit("room_joined", {
      idSala: idSala,
      cliente: cliente,
      numeroAgente: numeroAgente,
      message: "Conexión establecida exitosamente",
    });
  });

  // Cuando el agente envía un mensaje
  socket.on("agent_message", (data) => {
    const { idSala, mensaje, numeroAgente } = data;

    // Verificar que la sala existe
    if (roomConnections[idSala]) {
      const { cliente } = roomConnections[idSala];

      console.log(
        `📤 Mensaje de agente ${numeroAgente} en sala ${idSala} hacia cliente ${cliente}`,
      );

      // Enviar mensaje solo a la sala específica
      io.to(idSala).emit("chat_message", {
        convId: cliente,
        msg: {
          id: Date.now(),
          emisor: "agente",
          mensaje: mensaje.text || mensaje.mensaje,
          tipo: mensaje.tipo || "text",
          timestamp: Date.now(),
          numeroAgente: numeroAgente,
        },
      });

      // Enviar mensaje al cliente por WhatsApp
      sendGupshupMessage(cliente, {
        type: "text",
        text: mensaje.text || mensaje.mensaje,
      }).catch((err) =>
        console.error(
          `❌ Error enviando mensaje a cliente ${cliente}:`,
          err.message,
        ),
      );
    } else {
      console.error(`❌ Sala ${idSala} no encontrada`);
    }
  });

  // Cuando se finaliza una conversación
  socket.on("end_conversation", (data) => {
    const { idSala, numeroAgente } = data;

    if (roomConnections[idSala]) {
      const { cliente, agenteConectado } = roomConnections[idSala];

      console.log(
        `🔚 Finalizando conversación en sala ${idSala} (estaba conectada: ${agenteConectado})`,
      );

      // Limpiar estructuras de datos
      removeAgentConnection(numeroAgente, idSala);
      delete roomConnections[idSala];

      // Resetear sesión del cliente
      if (sessions[cliente]) {
        sessions[cliente].state = STATES.BOT;
        sessions[cliente].step = "menu";
        delete sessions[cliente].numeroAgente;
        delete sessions[cliente].idSala;
      }

      // Hacer que el socket salga de la sala
      socket.leave(idSala);

      // Notificar al cliente solo si la conversación estaba activa
      if (agenteConectado) {
        sendGupshupMessage(cliente, {
          type: "text",
          text: "👋 *Conversación Finalizada*\n\nGracias por contactarnos.\n\nEscribe *menu* para volver al menú principal.",
        }).catch((err) =>
          console.error(
            `❌ Error notificando fin de conversación:`,
            err.message,
          ),
        );
      }

      console.log(
        `✅ Conversación finalizada. Agente ${numeroAgente} ahora tiene ${agentConnections[numeroAgente]?.length || 0}/${MAX_CONNECTIONS_PER_AGENT} conexiones activas`,
      );

      // Confirmar al agente
      socket.emit("conversation_ended", {
        idSala: idSala,
        message: "Conversación finalizada exitosamente",
      });
    } else {
      console.error(`❌ Intento de finalizar sala inexistente: ${idSala}`);
      socket.emit("error", { message: "Sala no encontrada" });
    }
  });

  // Cuando un agente rechaza una solicitud de conexión
  socket.on("reject_connection", (data) => {
    const { idSala, numeroAgente, motivo } = data;

    if (roomConnections[idSala]) {
      const { cliente } = roomConnections[idSala];

      console.log(
        `❌ Agente ${numeroAgente} rechazó conexión en sala ${idSala}. Motivo: ${motivo || "No especificado"}`,
      );

      // Limpiar estructuras de datos
      removeAgentConnection(numeroAgente, idSala);
      delete roomConnections[idSala];

      // Resetear sesión del cliente
      if (sessions[cliente]) {
        sessions[cliente].state = STATES.BOT;
        sessions[cliente].step = "menu";
        delete sessions[cliente].numeroAgente;
        delete sessions[cliente].idSala;
      }

      // Notificar al cliente
      sendGupshupMessage(cliente, {
        type: "text",
        text: "🛠️ *Soporte Técnico*\n\n⚠️ El agente no puede atender tu solicitud en este momento.\n\n💡 Escribe *menu* para intentar conectarte con otro agente.",
      }).catch((err) =>
        console.error(`❌ Error notificando rechazo:`, err.message),
      );

      console.log(
        `✅ Solicitud rechazada. Agente ${numeroAgente} ahora tiene ${agentConnections[numeroAgente]?.length || 0}/${MAX_CONNECTIONS_PER_AGENT} conexiones`,
      );

      // Confirmar al agente
      socket.emit("connection_rejected", {
        idSala: idSala,
        message: "Solicitud rechazada exitosamente",
      });
    } else {
      console.error(`❌ Intento de rechazar sala inexistente: ${idSala}`);
      socket.emit("error", { message: "Sala no encontrada" });
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Cliente desconectado: ${socket.id}`);
  });
});

app.post("/webhook", async (req, res) => {
  const data = req.body;

  // ✅ Detectar cuando llega la asignación del agente
  if (data.type === "agent_assigned") {
    console.log(`🎯 Agente asignado: ${data.numeroAgente} para ${data.from}`);

    // Guardar el número del agente disponible si no existe
    if (!availableNumbers.includes(data.numeroAgente)) {
      availableNumbers.push(data.numeroAgente);
    }

    return res.sendStatus(200);
  }

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

        // --- CAPTURAR números enviados por agentes ---
        const extractedNumber = extractNumberFromMessage(text);
        if (extractedNumber && !availableNumbers.includes(extractedNumber)) {
          console.log(`✅ Número capturado: ${extractedNumber}`);
          availableNumbers.push(extractedNumber);
        }
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

    // ✅ Si ya está con un agente, verificar que el agente esté conectado en la sala
    if (sessions[from].state === STATES.WITH_AGENT) {
      const numeroAgente = sessions[from].numeroAgente;
      const idSala = sessions[from].idSala;

      // Verificar que la sala existe y el agente está activamente conectado
      if (
        !roomConnections[idSala] ||
        !roomConnections[idSala].agenteConectado
      ) {
        console.log(
          `⚠️ Cliente ${from} está en WITH_AGENT pero agente no conectado aún en sala ${idSala}`,
        );

        // Enviar mensaje de espera
        const waitPayload = {
          type: "text",
          text: "⏳ *Espera un momento*\n\nEl agente aún no ha aceptado la conversación.\n\n_Por favor espera a que se conecte..._",
        };
        await sendGupshupMessage(from, waitPayload);
        return res.sendStatus(200);
      }

      console.log(
        `📤 Reenviando mensaje de ${from} a sala ${idSala} (agente: ${numeroAgente})`,
      );

      // Enviar SOLO a la sala específica
      io.to(idSala).emit("chat_message", {
        convId: from,
        msg: {
          id: Date.now(),
          emisor: "contacto",
          mensaje: text || "",
          tipo: messageType,
          timestamp: Date.now(),
          origen: "whatsapp",
          mediaInfo: mediaInfo,
        },
      });

      // Si hay medios, procesarlos
      if (mediaInfo) {
        try {
          console.log(`⬇️ Descargando media de ${from}...`);
          const mediaData = await downloadMediaFromGupshup(mediaInfo.id, from);

          io.to(idSala).emit("media_received", {
            convId: from,
            media: {
              ...mediaInfo,
              buffer: mediaData.buffer.toString("base64"),
              content_type: mediaData.contentType,
              size: mediaData.size,
            },
          });

          console.log(`✅ Media enviado a sala ${idSala}`);
        } catch (mediaError) {
          console.error(`❌ Error procesando media:`, mediaError.message);
        }
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

    // Reset al menú
    if (text === "menu" || text === "menú") {
      sessions[from].step = "menu";
      sessions[from].state = STATES.BOT;
      console.log(`🔄 Sesión reiniciada para ${from}`);
    }

    let messagePayload = null;

    // FLUJO DEL BOT - MENÚ PRINCIPAL
    if (sessions[from].step === "menu") {
      // Si el usuario envía un archivo en el menú principal
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

        // Mostrar menú
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
      // Si el usuario envía un archivo en lugar de seleccionar una opción
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

      if (text === "btn_soporte" || text === "soporte") {
        console.log(`🔄 Usuario ${from} solicita soporte...`);
        sessions[from].state = STATES.CONNECTING;

        // ===== PASO 1: Aviso de conexión en progreso =====
        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        };

        await sendGupshupMessage(from, messagePayload);
        console.log(`📤 Mensaje de conexión enviado a ${from}`);

        // ===== PASO 2: Buscar agente disponible =====
        const numeroAgente = getNextAvailableNumber();

        if (!numeroAgente) {
          console.log(`❌ No hay agentes disponibles para ${from}`);
          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";

          const failurePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n❌ Lo sentimos, todos los agentes están ocupados.\n\n💡 Escribe *menu* para intentar más tarde.",
          };

          await sendGupshupMessage(from, failurePayload);
          return res.sendStatus(200);
        }

        // ===== PASO 3: Crear sala en estado "esperando agente" =====
        const idSala = `${numeroAgente}-${from}`;

        // Agregar conexión al agente (reservar el slot)
        const added = addAgentConnection(numeroAgente, idSala);

        if (!added) {
          console.log(
            `❌ Agente ${numeroAgente} alcanzó el límite de conexiones`,
          );
          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";

          const failurePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n❌ Lo sentimos, no hay agentes disponibles en este momento.\n\n💡 Escribe *menu* para intentar más tarde.",
          };

          await sendGupshupMessage(from, failurePayload);
          return res.sendStatus(200);
        }

        // Registrar sala en estado "esperando conexión del agente"
        roomConnections[idSala] = {
          agente: numeroAgente,
          cliente: from,
          agenteConectado: false, // ⚠️ Agente AÚN NO se ha unido a la sala
          createdAt: new Date().toISOString(),
        };

        // Actualizar sesión - MANTENER EN CONNECTING hasta que agente se una
        sessions[from].numeroAgente = numeroAgente;
        sessions[from].idSala = idSala;
        // ⚠️ NO cambiar a WITH_AGENT aquí

        console.log(
          `⏳ Sala ${idSala} creada en espera. Agente ${numeroAgente} reservó slot ${agentConnections[numeroAgente].length}/${MAX_CONNECTIONS_PER_AGENT}`,
        );

        // ===== PASO 4: Notificar al agente que hay una nueva solicitud =====

        // Enviar notificación broadcast a todos los sockets del agente
        // El agente debe responder con join_room para activar la sala
        io.emit("new_connection_request", {
          convId: from,
          numeroAgente: numeroAgente,
          idSala: idSala,
          mensaje: "soporte",
          timestamp: new Date().toISOString(),
          requiresAction: true, // El agente debe unirse explícitamente
        });

        // Notificar al cliente que está esperando
        const waitingPayload = {
          type: "text",
          text: `🛠️ *Solicitud Enviada*\n\n⏳ Se ha notificado al agente #${numeroAgente}.\n\n_Espera a que el agente acepte la conversación..._`,
        };

        await sendGupshupMessage(from, waitingPayload);
        console.log(
          `📢 Notificación de nueva solicitud enviada para sala ${idSala}`,
        );

        return res.sendStatus(200);
      } else if (text === "btn_ventas") {
        console.log(`💰 Usuario ${from} solicita información de ventas`);
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nVisita nuestra web: https://tuapp.com/ventas\n\nEscribe *menu* para volver.",
        };
        sessions[from].step = "menu";
      } else {
        // Si el usuario escribe algo que no es una opción válida
        console.log(`⚠️ Entrada inválida de ${from}: "${text}"`);
        messagePayload = {
          type: "text",
          text: "❌ No entendí tu respuesta.\n\nEscribe *menu* para ver las opciones disponibles.",
        };
      }
    }

    // ✅ Enviar respuesta final si existe un payload
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

// Endpoint para recibir confirmaciones de entrega/lectura (opcional)
app.post("/webhook/status", (req, res) => {
  console.log("📊 Status update:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// Endpoint para obtener estado de agentes (opcional, para debugging)
app.get("/agents/status", (req, res) => {
  const roomsStatus = Object.entries(roomConnections).map(([idSala, info]) => ({
    idSala,
    agente: info.agente,
    cliente: info.cliente,
    conectado: info.agenteConectado,
    createdAt: info.createdAt,
  }));

  res.json({
    availableNumbers: availableNumbers,
    agentConnections: agentConnections,
    activeRooms: Object.keys(roomConnections).length,
    rooms: roomsStatus,
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => res.send("Bot Online 🚀"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
