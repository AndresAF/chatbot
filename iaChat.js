// iaChat.js
// Filtro determinista (sin costo de API) para contenido claramente fuera de
// lugar: insultos, violencia, contenido sexual explícito. Se revisa ANTES
// de llamar al extractor para no gastar tokens en estos casos, y para que
// la respuesta sea siempre la misma, predecible, sin depender de que el
// modelo la redacte bien cada vez.

const PATRONES_INAPROPIADOS = [
  /\b(imbecil|imbécil|estupid|idiota|pendej|hijo\s*de\s*puta|maldit|cabron|cabrón|put[oa]|marica|verga|chingu?[aeo]|jod[ae]|mierda|culer[oa]|carajo|gilipollas|zorra|perra)\w*/i,
  /\b(matar|asesinat|asesin[oa]|violenci|golpe[ae]r|disparar|bomba|terroris|suicid)\w*/i,
  /\b(porno|pornograf|sexo\s*explicit|desnud|xxx|nude[s]?)\w*/i,
];

function esMensajeInapropiado(texto) {
  return PATRONES_INAPROPIADOS.some(p => p.test(texto));
}

// Detecta si el cliente está pidiendo explícitamente hablar con una persona
// (no con el bot). Determinista, sin costo de API — igual que el filtro de
// arriba, esto se revisa antes de llamar al extractor.
const PATRONES_PIDE_HUMANO = [
  /hablar con (un|una|el|la)?\s*(humano|persona|alguien|representante|agente|asesor)/i,
  /(quiero|necesito|puedo)\s+(hablar|comunicarme)\s+con\s+(alguien|un humano|una persona)/i,
  /atenci[oó]n al cliente/i,
  /(no eres|no es)\s+(una?\s+)?(persona|humano)/i,
];

function pideHumano(texto) {
  return PATRONES_PIDE_HUMANO.some(p => p.test(texto));
}

// Temas de salud/contraindicaciones (embarazo, alergias, medicamentos,
// reacciones en la piel, etc.): el bot NUNCA debe opinar ni dar tranquilidad
// médica falsa — eso es responsabilidad legal real para un negocio de
// estética. Determinista a propósito: no queremos depender de que el
// redactor "se acuerde" de no opinar en cada llamada.
const PATRONES_TEMA_MEDICO = [
  /\b(embarazo|embarazada|lactancia|lactando|amamant\w*)\b/i,
  /\b(medicament[oa]s?|f[aá]rmaco|tratamiento m[eé]dico|is[oó]tretinoina|retinol|ácido retinoico)\b/i,
  /\b(alergi[ac]?[oa]?s?|al[eé]rgic[oa]s?|contraindicaci[oó]n(es)?)\b/i,
  /\b(reacci[oó]n (en la piel|al[eé]rgica)|se me irrit[oó]|me sali[oó] (una |un )?(roncha|ampolla|salp[uú]llido)|efectos secundarios)\b/i,
  /es seguro (hacerme|usar|aplicarme) esto/i,
];

function esTemaMedico(texto) {
  return PATRONES_TEMA_MEDICO.some(p => p.test(texto));
}

// Queja o inconformidad explícita del cliente: se responde con una disculpa
// breve (sin sobre-disculparse) y se escala a un humano — no es tarea del
// bot resolver ni defenderse. Determinista, mismo criterio que arriba.
const PATRONES_QUEJA = [
  /\b(queja|inconforme|p[eé]simo|terrible|decepcionad[oa]|mal atendid[oa]|mal servicio)\b/i,
  /me cobraron de m[aá]s/i,
  /cancelaron sin avisar/i,
  /no me gust[oó] (nada|para nada)/i,
  /(esto|eso) (est[aá] mal|es una falta de respeto)/i,
];

function esQueja(texto) {
  return PATRONES_QUEJA.some(p => p.test(texto));
}

module.exports = { esMensajeInapropiado, pideHumano, esTemaMedico, esQueja };
