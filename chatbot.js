// ============================================
// GIV Chatbot — Motor de decisiones + FAQ
// Sin APIs externas, 100% local
// ============================================

const FAQ = [
  {
    patrones: ['que es giv', 'que hacen', 'como funciona', 'servicio', 'hacen', 'hacen ustedes', 'que ofrecen', ' ofrecen'],
    categoria: 'info_general',
    respuesta: 'GIV (Gestion Integral Vehicular) te ayuda a verificar el estado legal de tu auto sin llevarlo al centro. Consultamos REPUVE y Finanzas CDMX GRATIS, y si quieres nosotros hacemos la verificacion a domicilio por solo $700 MXN.',
    accion: null
  },
  {
    patrones: ['cuanto cuesta', 'precio', 'costo', 'cuanto vale', 'pago', 'pagar', 'tarifa', 'tarifas'],
    categoria: 'precio',
    respuesta: '!PRECIO',
    accion: 'precio'
  },
  {
    patrones: ['que es repuve', 'repuve', 'reporte robo', 'robo', 'robado', 'tiene reporte'],
    categoria: 'info_repuve',
    respuesta: 'REPUVE es el Registro Publico Vehicular. Consulta si tu auto tiene reporte de robo activo a nivel nacional. Es GRATIS con nosotros — captura tu placa arriba.',
    accion: null
  },
  {
    patrones: ['finanzas', 'adeudos', 'multas', 'infracciones', 'tenencia', 'debo', 'deuda'],
    categoria: 'info_adeudos',
    respuesta: 'Consultamos el portal de Finanzas CDMX para ver si tu carro tiene adeudos (infracciones, tenencia, etc). Es gratis — nos dices tu placa y te decimos cuanto debes.',
    accion: null
  },
  {
    patrones: ['verificacion', 'sin llevar', 'domicilio', 'sin mover', 'a domicilio', 'no quiero ir'],
    categoria: 'servicio_verificacion',
    respuesta: 'Nuestro servicio premium: hacemos la verificacion vehicular sin que lleves tu auto. Venimos por el, lo llevamos al centro de verificacion y te lo regresamos. Costo: $700 MXN + cualquier adeudo que tenga el auto.',
    accion: null
  },
  {
    patrones: ['horario', 'atienden', 'horarios', 'cuando', 'abren', 'que hora'],
    categoria: 'horarios',
    respuesta: 'Atendemos de Lunes a Sabado de 9:00 AM a 7:00 PM. Los domingos solo con cita previa por WhatsApp.',
    accion: null
  },
  {
    patrones: ['donde', 'ubicacion', 'direccion', 'oficina', 'zona', 'cobertura', 'donde están'],
    categoria: 'cobertura',
    respuesta: 'Cubrimos toda CDMX y Estado de Mexico. Como es servicio a domicilio, no necesitas ir a ninguna oficina — nosotros vamos por ti. Los municipios que cubrimos: CDMX (todas las alcaldias), EdoMex (Tlalnepa, Naucalpan, Ecatepec, Neza, Tultitlan, Coacalco, y mas).',
    accion: null
  },
  {
    patrones: ['whatsapp', 'contacto', 'telefono', 'llamar', 'hablar', 'asesor', 'persona humana'],
    categoria: 'contacto',
    respuesta: '!CONTACTO',
    accion: 'contacto'
  },
  {
    patrones: ['cuanto tarda', 'tiempo', 'tardan', 'demora', 'cuando listo', 'listo'],
    categoria: 'tiempo',
    respuesta: 'La consulta gratuita (REPUVE + Finanzas) toma menos de 30 segundos. El servicio de verificacion a domicilio toma de 2 a 3 dias habiles en total: 1 dia por el auto, 1-2 para tramite y entrega.',
    accion: null
  },
  {
    patrones: ['necesito', 'requisitos', 'documentos', 'papeles', 'que ocupo', 'que papeles', 'requisitos'],
    categoria: 'requisitos',
    respuesta: 'Para el servicio de verificacion solo necesitas:\n1. Tarjeta de circulacion (original)\n2. comprobante de domicilio reciente\n3. Identificacion oficial\n\nTe las pedimos al recoger el auto. Para la consulta GRATIS solo necesitas la placa.',
    accion: null
  },
  {
    patrones: ['gratis', 'consulta gratis', 'no quiero pagar', 'sin costo', 'costo consulta'],
    categoria: 'gratis',
    respuesta: 'La consulta de REPUVE y Finanzas es 100% GRATIS. Solo pagas si contratas el servicio de verificacion a domicilio ($700 MXN + adeudos del auto). Queremos que sepas el estado de tu carro sin que des un centavo.',
    accion: null
  },
  {
    patrones: ['hola', 'buenas', 'buenos', 'hey', 'hi', 'hello', 'que tal', 'saludos'],
    categoria: 'saludo',
    respuesta: '¡Hola! Soy el asistente virtual de GIV 👋\n\nEn que te ayudo?\n1. Consultar mi placa GRATIS\n2. Precio del servicio de verificacion\n3. Contactar por WhatsApp',
    accion: null
  },
  {
    patrones: ['efectivo', 'transferencia', 'tarjeta', 'metodo pago', 'como pago', 'pago'],
    categoria: 'metodo_pago',
    respuesta: 'Aceptamos:\n- Efectivo\n- Transferencia bancaria\n- Tarjeta de debito/credito (via terminal)\n\nEl pago se realiza cuando entregamos el auto verificado.',
    accion: null
  }
];

// Variables de estado por sesion (en memoria, se reinicia al restartar)
const sesiones = new Map();

function generarIdSesion() {
  return 'giv_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}

// Normalizar texto para comparacion
function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // quitar acentos
    .replace(/[^a-z0-9s]/g, "")
    .trim();
}

// Calcular similitud simple (Jaccard en palabras)
function similitudFrase(a, b) {
  const palabrasA = new Set(normalizar(a).split(' ').filter(p => p.length > 1));
  const palabrasB = new Set(normalizar(b).split(' ').filter(p => p.length > 1));
  if (palabrasA.size === 0 || palabrasB.size === 0) return 0;
  const interseccion = [...palabrasA].filter(p => palabrasB.has(p)).length;
  const union = new Set([...palabrasA, ...palabrasB]).size;
  return interseccion / union;
}

// Buscar la mejor respuesta
function procesarMensaje(mensaje, sesionId) {
  const msgNormalizado = normalizar(mensaje);
  let mejorMatch = null;
  let mejorScore = 0;
  
  for (const faq of FAQ) {
    for (const patron of faq.patrones) {
      // Match exacto de patron
      const score = similitudFrase(mensaje, patron);
      // Bonus si el texto contiene el patron exacto
      const bonus = msgNormalizado.includes(normalizar(patron)) ? 0.5 : 0;
      const totalScore = score + bonus;
      
      if (totalScore > mejorScore && totalScore > 0.25) {
        mejorScore = totalScore;
        mejorMatch = faq;
      }
    }
  }
  
  if (mejorMatch) {
    let respuesta = mejorMatch.respuesta;
    
    // Manejar acciones especiales
    if (mejorMatch.accion === 'precio') {
      respuesta = 'Los precios de GIV son:\n\n🛡️ Consulta REPUVE + Finanzas: GRATIS\n🚗 Verificacion a domicilio: $700 MXN\n💰 Los adeudos de tu auto se pagan aparte (sin comision extra de nuestra parte)\n\nSi tienes adeudos, te decimos exactamente cuanto antes de que pagues.';
    }

    if (mejorMatch.accion === 'contacto') {
      respuesta = 'Puedes contactarnos por WhatsApp: https://wa.me/5215660951415\n\nAhi un asesor real te atendera al momento. O dejamos tu numero y te llamanos?';
    }
    
    return {
      respuesta: respuesta,
      categoria: mejorMatch.categoria,
      confianza: Math.min(mejorScore, 1.0),
      sugerencias: []
    };
  }
  
  // No encontro match — sugerir FAQ populares
  return {
    respuesta: `No estoy seguro de entenderte. Puedo ayudarte con:

1. "cuanto cuesta" — precios
2. "verificacion" — servicio a domicilio
3. "repuve" o "finanzas" — consulta gratis
4. "whatsapp" — contacto humano

Escribe una palabra de la lista o pregunta directamente.`,
    categoria: 'fallback',
    confianza: 0,
    sugerencias: ['cuanto cuesta', 'servicio verificacion', 'consulta gratis', 'contacto whatsapp']
  };
}

module.exports = { procesarMensaje, FAQ };
