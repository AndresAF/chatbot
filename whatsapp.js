// whatsapp.js
// Envío de mensajes de WhatsApp vía Twilio. Nunca lanza: un envío fallido
// (límite, red, número inválido...) no debe tumbar el proceso ni el flujo
// que lo llama — devuelve { ok, error? } para que el caller decida.

const twilio = require("twilio");

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// `from` es opcional — por defecto usa el número configurado en
// TWILIO_WHATSAPP_FROM (para envíos proactivos: recordatorios, relevo de
// recepción, avisos de handoff). Al RESPONDER a un mensaje entrante hay que
// pasar explícitamente el número al que el cliente escribió (req.body.To),
// para no depender de que esa env var coincida — si el cliente le escribió
// al número de producción pero TWILIO_WHATSAPP_FROM apunta al sandbox (o
// viceversa), Twilio rechaza el envío con el error 63015.
async function enviarWhatsApp(to, body, from = process.env.TWILIO_WHATSAPP_FROM) {
  if (!twilioClient) {
    console.log(`[SIMULADO ${from || "(sin from)"} -> ${to}]: ${body}`);
    return { ok: true, simulado: true };
  }
  try {
    await twilioClient.messages.create({
      from,
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
