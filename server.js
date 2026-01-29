require("dotenv").config();
const express = require("express");
const axios = require("axios");
const FormData = require("form-data");

const app = express();
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

const sessions = {};
const availableNumbers = [];

// Función para obtener el siguiente número disponible
function getNextAvailableNumber() {
  return availableNumbers.shift(); // toma el primer número y lo elimina del array
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

    // Determinar tipo de archivo según la respuesta
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

app.post("/webhook", async (req, res) => {
  const data = req.body;

  // ✅ Detectar cuando llega la asignación del agente
  if (data.type === "agent_assigned") {
    console.log(`🎯 Agente asignado: ${data.numeroAgente} para ${data.from}`);

    // Guardar el número del agente disponible
    availableNumbers.push(data.numeroAgente);

    // O enviarlo directamente al usuario
    /* await sendGupshupMessage(data.from, {
      type: "text",
      text: `✅ Agente conectado. Tu número asignado es: ${data.numeroAgente}`,
    });*/

    return res.sendStatus(200);
  }
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message || !message.from) {
      return res.sendStatus(200);
    }

    if (data.type === "agent_assigned") {
      console.log(
        `🎯 Agente asignado (legacy): ${data.numeroAgente} para ${data.from}`,
      );
      availableNumbers.push(data.numeroAgente);
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
        if (extractedNumber) {
          console.log(`✅ Número capturado: ${extractedNumber}`);
          availableNumbers.push(extractedNumber); // availableNumbers debe estar declarado fuera de la función
        }

        // --- ENTREGAR NÚMERO AL USUARIO ---
        if (text === "dar número") {
          const numberToSend = getNextAvailableNumber(); // tu función para tomar el siguiente número
          let payload;
          if (numberToSend) {
            payload = {
              type: "text",
              text: `📱 Número asignado: ${numberToSend}`,
            };
          } else {
            payload = {
              type: "text",
              text: "⚠️ No hay números disponibles en este momento.",
            };
          }
          // await sendGupshupMessage(from, payload);
          return res.sendStatus(200); // importante, para que no siga procesando el mensaje
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

    // Si ya está con un agente, reenviar mensaje (con medios) a la plataforma externa
    if (sessions[from].state === STATES.WITH_AGENT) {
      const numeroAgente = sessions[from].numeroAgente;
      const idSala = `${numeroAgente}-${from}`;
      console.log(`📤 Reenviando mensaje de ${from} al soporte...`);

      io.to(idSala).emit("chat_message", {
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

      // return res.sendStatus(200);

      let payloadToSupport = {
        from,
        text: text || "",
        type: "incoming_message",
        message_type: messageType,
        timestamp: new Date().toISOString(),
        object: "whatsapp_business_account",
      };

      // Si hay medios, descargarlos y enviarlos
      if (mediaInfo) {
        try {
          console.log(`⬇️ Descargando media de ${from}...`);
          const mediaData = await downloadMediaFromGupshup(mediaInfo.id, from);

          payloadToSupport.media = {
            ...mediaInfo,
            buffer: mediaData.buffer.toString("base64"), // Convertir a base64 para enviar
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
          // Aún así enviamos el mensaje pero sin el archivo
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

      // Si el usuario envía un archivo mientras está conectando, notificarle
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

        // Mostrar el menú después del mensaje
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

        await sendGupshupMessage(from, messagePayload);
        await new Promise((resolve) => setTimeout(resolve, 500)); // Pequeña pausa
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

      if (text === "btn_soporte") {
        console.log(`🔄 Usuario ${from} solicita soporte...`);
        sessions[from].state = STATES.CONNECTING;

        // ===== PASO 1: Guardar "soporte" en el chat =====
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
          console.log(`✅ Mensaje 'soporte' guardado en el chat`);
        } catch (e) {
          console.error("⚠️ Error guardando 'soporte' en chat:", e.message);
        }

        // ===== PASO 2: Aviso de conexión en progreso =====
        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        };

        await sendGupshupMessage(from, messagePayload);
        console.log(`📤 Mensaje de conexión enviado a ${from}`);

        // ===== PASO 3: Intentar conexión al webhook externo =====
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

          console.log(`✅ Agente conectado para ${from}`);

          // ===== PASO 4: Éxito - Aviso de conexión exitosa (con instrucciones para medios) =====
          sessions[from].state = STATES.WITH_AGENT;
          // sessions[from].numeroAgente = numero;
          const successPayload = {
            type: "text",
            text: "🛠️ *Soporte Conectado*\n\n✅ Un agente está listo para ayudarte.\n\n📎 *Ahora puedes enviar:*\n• Imágenes 📷\n• Videos 🎥\n• Audios 🎵\n• Documentos 📄\n\n_Escribe tu mensaje o envía archivos directamente._",
          };

          await sendGupshupMessage(from, successPayload);
          console.log(`✅ Mensaje de éxito enviado a ${from}`);
        } catch (error) {
          // ===== PASO 4: Error - Aviso de falla de conexión =====
          const errorType =
            error.code === "ECONNABORTED" ? "Timeout (>10s)" : error.message;
          console.log(`❌ Soporte no disponible para ${from}: ${errorType}`);

          // Restablecer estado a BOT
          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";

          const failurePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n❌ Lo sentimos, en este momento no hay agentes disponibles.\n\n💡 Escribe *menu* para intentar más tarde o elige otra opción.",
          };

          await sendGupshupMessage(from, failurePayload);
          console.log(`❌ Mensaje de error enviado a ${from}`);
        }

        // ✅ RETORNAR AQUÍ para evitar el envío duplicado
        return res.sendStatus(200);
      } else if (text === "btn_ventas") {
        console.log(`💰 Usuario ${from} solicita información de ventas`);
        messagePayload = {
          type: "text",
          text: "💰 *Ventas*\n\nVisita nuestra web: https://tuapp.com/ventas\n\nEscribe *menu* para volver.",
        };
        sessions[from].step = "menu";
      } else if (text === "soporte") {
        console.log(`🔄 Usuario ${from} escribió "soporte" como texto...`);
        sessions[from].state = STATES.CONNECTING;

        // ===== ENVIAR CON COLA Y PAUSA =====
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
          console.log(`✅ Texto 'soporte' con cola/pausa enviado al chat`);
        } catch (e) {
          console.error("⚠️ Error enviando 'soporte':", e.message);
        }

        messagePayload = {
          type: "text",
          text: "🛠️ *Conectando con Soporte*\n\n⏳ Buscando agente disponible...\n\n_Por favor espera un momento._",
        };

        await sendGupshupMessage(from, messagePayload);

        // Intentar conexión completa
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

          console.log(`✅ Agente conectado para ${from} (vía texto)`);
          sessions[from].state = STATES.WITH_AGENT;
          sessions[from].numeroAgente = numero;

          const successPayload = {
            type: "text",
            text: "🛠️ *Soporte Conectado*\n\n✅ Un agente está listo para ayudarte.\n\n📎 *Ahora puedes enviar:*\n• Imágenes 📷\n• Videos 🎥\n• Audios 🎵\n• Documentos 📄\n\n_Escribe tu mensaje o envía archivos directamente._",
          };

          await sendGupshupMessage(from, successPayload);
        } catch (error) {
          console.log(`❌ Soporte no disponible: ${error.message}`);
          sessions[from].state = STATES.BOT;
          sessions[from].step = "menu";

          const failurePayload = {
            type: "text",
            text: "🛠️ *Soporte Técnico*\n\n❌ Lo sentimos, no hay agentes disponibles.\n\n💡 Escribe *menu* para intentar más tarde.",
          };

          await sendGupshupMessage(from, failurePayload);
        }

        return res.sendStatus(200);
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

app.get("/", (req, res) => res.send("Bot Online 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
