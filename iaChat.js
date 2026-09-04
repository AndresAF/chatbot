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

module.exports = { esMensajeInapropiado };
