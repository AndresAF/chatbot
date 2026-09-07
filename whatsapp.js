// whatsapp.js
// Envío de mensajes de WhatsApp vía Twilio. Nunca lanza: un envío fallido
// (límite, red, número inválido...) no debe tumbar el proceso ni el flujo
// que lo llama — devuelve { ok, error? } para que el caller decida.

const twilio = require("twilio");

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

async function enviarWhatsApp(to, body) {
  if (!twilioClient) {
    console.log(`[SIMULADO -> ${to}]: ${body}`);
    return { ok: true, simulado: true };
  }
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to,
      body,
    });
    return { ok: true };
  } catch (err) {
    console.error(`Error enviando WhatsApp a ${to}:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { enviarWhatsApp, estaConfigurado: !!twilioClient };
