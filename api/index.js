// Vercel Serverless Handler — GIV Completo + Supabase
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const { Jimp, JimpMime } = require('jimp');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Servir archivos estaticos
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================
// SUPABASE — Base de datos persistente
// ============================================
const SUPABASE_URL = 'https://irnzvibxkjfopapyknhc.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlybnp2aWJ4a2pmb3BhcHlrbmhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjY0NzI1NSwiZXhwIjoyMDk4MjIzMjU1fQ.JKEeVOaEFjkaHEPiguzBXtNDS9lU8xQrQSMx7l4_1iE';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ============================================
// OCR — Tarjeta de Circulacion
// ============================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imagenes (JPEG, PNG, WEBP, GIF)'));
    }
  }
});

async function preprocesarImagen(buffer) {
  const image = await Jimp.read(buffer);
  if (image.bitmap.width > 1800) {
    image.resize({ w: 1800 });
  }
  image.greyscale();
  image.contrast(0.3);
  image.brightness(0.05);
  return await image.getBuffer(JimpMime.png);
}

function parsearTarjetaCirculacion(texto) {
  const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const fullText = texto.toUpperCase();

  const resultado = {
    placa: null, niv: null, vin: null, nombre: null,
    marca: null, modelo: null, anio: null, cilindros: null,
    puertas: null, combustible: null, entidad: null, municipio: null,
    raw: lineas.slice(0, 30)
  };

  // PLACA
  const placaPatrones = [
    /\b([A-Z]{3}[-]?[0-9]{3,4})\b/i,
    /\b([0-9]{3}[-]?[A-Z]{3}[-]?[0-9]{0,3})\b/i,
    /\b([A-Z][0-9]{3}[A-Z]{2})\b/i,
    /\b(PLACA[S]?:\s+([A-Z0-9\-]{4,}))/i,
  ];
  for (const patron of placaPatrones) {
    const match = fullText.match(patron);
    if (match) {
      const placa = (match[2] || match[1]).replace(/[\s\-]/g, '').toUpperCase();
      if (placa.length >= 5 && placa.length <= 9) { resultado.placa = placa; break; }
    }
  }

  // NIV/VIN
  const nivRegex = /\b([A-HJ-NPR-Z0-9]{17})\b/ig;
  const nivMatches = [...fullText.matchAll(nivRegex)];
  for (const m of nivMatches) {
    const candidato = m[1].toUpperCase();
    const letras = (candidato.match(/[A-HJ-NPR-Z]/g) || []).length;
    const numeros = (candidato.match(/[0-9]/g) || []).length;
    if (letras >= 2 && numeros >= 2) { resultado.niv = candidato; resultado.vin = candidato; break; }
  }
  if (!resultado.niv) {
    for (const linea of lineas) {
      const m = linea.match(/(?:NIV|VIN|NO\s*SERIE)[:\\s]*([A-HJ-NPR-Z0-9]{12,})/i);
      if (m) { resultado.niv = m[1].toUpperCase(); resultado.vin = resultado.niv; break; }
    }
  }

  // AÑO
  const anioRegex = /\b(19[89]\d|20[0-3]\d)\b/;
  const anioMatch = fullText.match(anioRegex);
  if (anioMatch) resultado.anio = anioMatch[0];

  // MARCA
  const marcas = ['TOYOTA','HONDA','NISSAN','CHEVROLET','FORD','VW','VOLKSWAGEN','MAZDA','KIA','HYUNDAI','BMW','MERCEDES','AUDI','JEEP','DODGE','GMC','CHEVY','CHRYSLER','SEAT','RENAULT','MITSUBISHI','SUBARU','SUZUKI','FIAT','PORSCHE','LAND ROVER','JAGUAR','MINI','TESLA','BUICK','CADILLAC','INFINITI','ACURA','LEXUS','LINCOLN','RAM','ALFA ROMEO','BYD','MG'];
  for (const marca of marcas) {
    if (fullText.includes(marca)) {
      resultado.marca = marca.charAt(0) + marca.slice(1).toLowerCase();
      break;
    }
  }

  // MODELO
  for (const linea of lineas) {
    const m = linea.match(/(?:MODELO|VEHICULO|VEHÍCULO|TIPO)[:\\s]+([A-Za-z0-9][A-Za-z0-9\s]*)/i);
    if (m && m[1].trim().length >= 2) {
      const candidato = m[1].trim();
      if (!/^(MARCA|NIV|ANO|PLACA|NOMBRE|ENTIDAD|CILINDROS|PUERTAS|TENENCIA|MODELO)$/i.test(candidato)) {
        resultado.modelo = candidato; break;
      }
    }
    if (resultado.marca && linea.toUpperCase().includes(resultado.marca.toUpperCase()) && !linea.match(/MODELO|TIPO/i)) {
      const partes = linea.split(/\s+/);
      const idxMarca = partes.findIndex(p => p.toUpperCase() === resultado.marca.toUpperCase());
      if (idxMarca >= 0 && idxMarca < partes.length - 1) {
        const modeloPart = partes.slice(idxMarca + 1).join(' ');
        if (modeloPart.length >= 2 && modeloPart.length < 25) { resultado.modelo = modeloPart; break; }
      }
    }
  }

  // NOMBRE
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(/(?:NOMBRE|PROPIETARIO|TITULAR|NAME)[:\\s]*([A-Za-zÀ-ÿ\s\.]{5,})/i);
    if (m) { resultado.nombre = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  // ENTIDAD
  const estados = ['CDMX','ESTADO DE MEXICO','JALISCO','NUEVO LEON','VERACRUZ','GUANAJUATO','PUEBLA','CHIAPAS','MICHOACAN','OAXACA','TABASCO','SINALOA','GUERRERO','TAMAULIPAS','COAHUILA','HIDALGO','SAN LUIS POTOSI','QUERETARO','YUCATAN','QUINTANA ROO','SONORA','DURANGO','ZACATECAS','NAYARIT','COLIMA','AGUASCALIENTES','MORELOS','CAMPECHE','BAJA CALIFORNIA','BCS'];
  for (const estado of estados) {
    if (fullText.includes(estado)) { resultado.entidad = estado; break; }
  }

  // CILINDROS
  for (const linea of lineas) {
    const m = linea.match(/(?:CILINDROS|CIL|Motor|cilindrada)[:\\s]*(\d)/i);
    if (m) { resultado.cilindros = m[1]; break; }
  }

  // PUERTAS
  for (const linea of lineas) {
    const m = linea.match(/(?:PUERTAS)[:\\s]*(\d)/i);
    if (m) { resultado.puertas = m[1]; break; }
  }

  return resultado;
}

// ============================================
// REPUVE SCRAPER
// ============================================
async function consultarRepuve(placa) {
  const placaLimpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const http = require('http');

  try {
    const postBody = `placa=${placaLimpia}&pageSource=index.jsp`;

    const html = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'www2.repuve.gob.mx',
        port: 8080,
        path: '/ciudadania/servletconsulta',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9',
          'Referer': 'http://www2.repuve.gob.mx:8080/ciudadania/index.jsp'
        },
        rejectUnauthorized: false,
        timeout: 15000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postBody);
      req.end();
    });

    if (html.includes('Error 503') || html.includes('Service Unavailable')) {
      return {
        placa: placaLimpia, fuente: 'REPUVE', fechaConsulta: new Date().toISOString(),
        estatusRobo: 'SERVICIO_DISPONIBLE',
        error: 'REPUVE no disponible desde este servidor. Se realizara manualmente al procesar tu servicio.',
        datos: null
      };
    }

    const tieneRobo = html.includes('REPORTE DE ROBO') || html.includes('reporte de robo');
    const sinRobo = html.includes('SIN REPORTE DE ROBO') || html.includes('Sin reporte de robo');
    const datos = extraerDatosRepuve(html);

    return {
      placa: placaLimpia, fuente: 'REPUVE', fechaConsulta: new Date().toISOString(),
      estatusRobo: sinRobo ? 'SIN REPORTE' : (tieneRobo ? 'CON REPORTE DE ROBO' : 'NO VERIFICABLE'),
      datos: datos
    };
  } catch (error) {
    return {
      placa: placaLimpia, fuente: 'REPUVE', fechaConsulta: new Date().toISOString(),
      estatusRobo: 'ERROR', error: error.message, datos: null
    };
  }
}

function extraerDatosRepuve(html) {
  const datos = {};

  if (html.includes('SIN REPORTE DE ROBO')) datos.estatusRobo = 'SIN REPORTE';
  else if (html.includes('REPORTE DE ROBO')) datos.estatusRobo = 'CON REPORTE DE ROBO';
  else datos.estatusRobo = 'NO VERIFICABLE';

  // Extraer todos los pares <tr><td>ETIQUETA:</td><td>VALOR</td></tr> del HTML
  const regex = /<tr><td>([^<]+):<\/td>\s*<td>([^<]+)<\/td><\/tr>/gi;
  let match;
  const todosLosCampos = {};
  while ((match = regex.exec(html)) !== null) {
    todosLosCampos[match[1].trim()] = match[2].trim();
  }

  // Mapear nombres del HTML (español con acentos) a keys estandar
  const mapeo = {
    'marca': ['Marca'],
    'modelo': ['Modelo'],
    'anio': ['Año Modelo', 'ANO MODELO'],
    'clase': ['Clase'],
    'tipo': ['Tipo'],
    'niv': ['Número de Identificación Vehicular (NIV)', 'Numero de Identificacion Vehicular (NIV)'],
    'nci': ['Número de Constancia de Inscripción (NCI)', 'Numero de Constancia de Inscripcion (NCI)'],
    'placa': ['Placa', 'Placas'],
    'puertas': ['Número de puertas', 'Numero de puertas'],
    'pais_origen': ['País de origen', 'Pais de origen'],
    'version': ['Versión', 'Version'],
    'desplazamiento': ['Desplazamiento (cc/L)'],
    'cilindros': ['Número de cilindros', 'Numero de cilindros'],
    'planta_ensamble': ['Planta de ensamble'],
    'raw_complementarios': ['Datos complementarios'],
    'institucion': ['Institución que lo inscribió', 'Institucion que lo inscribio'],
    'fecha_inscripcion': ['Fecha de inscripción', 'Fecha de inscripcion'],
    'entidad': ['Entidad que emplacó', 'Entidad que emplaco'],
    'fecha_emplacado': ['Fecha de emplacado'],
    'fecha_actualizacion': ['Fecha de última actualización', 'Fecha de ultima actualizacion'],
    'folio_constancia': ['Folio de Constancia de Inscripción', 'Folio de Constancia de Inscripcion'],
    'observaciones': ['Observaciones']
  };

  for (const [key, posibles] of Object.entries(mapeo)) {
    for (const pos of posibles) {
      if (todosLosCampos[pos]) {
        datos[key] = todosLosCampos[pos];
        break;
      }
    }
  }

  Object.keys(datos).forEach(k => { if (!datos[k]) delete datos[k]; });

  return Object.keys(datos).length > 1 ? datos : { estatusRobo: datos.estatusRobo };
}

// ============================================
// ADEUDOS CDMX
// ============================================
async function consultarAdeudosCDMX(placa) {
  const placaLimpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  try {
    const https = require('https');
    const postData = `placa=${placaLimpia}`;

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'data.finanzas.cdmx.gob.mx', port: 443, path: '/consulta_adeudos',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
        rejectUnauthorized: false, timeout: 15000
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postData);
      req.end();
    });

    const adeudos = parsearAdeudos(result.toString());

    return {
      placa: placaLimpia, fuente: 'Finanzas CDMX', fechaConsulta: new Date().toISOString(),
      adeudos: adeudos,
      tieneAdeudos: adeudos ? adeudos.total > 0 : false,
      totalAdeudos: adeudos ? adeudos.total : 0
    };
  } catch (error) {
    return {
      placa: placaLimpia, fuente: 'Finanzas CDMX', fechaConsulta: new Date().toISOString(),
      error: error.message, adeudos: null, tieneAdeudos: false, totalAdeudos: 0
    };
  }
}

function parsearAdeudos(html) {
  const filas = [];
  const filaRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  let total = 0;

  while ((match = filaRegex.exec(html)) !== null) {
    const celdas = match[1];
    const celdaRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const valores = [];
    let celdaMatch;

    while ((celdaMatch = celdaRegex.exec(celdas)) !== null) {
      valores.push(celdaMatch[1].replace(/<[^>]+>/g, '').trim());
    }

    if (valores.length >= 3) {
      filas.push(valores);
      const montoStr = valores.find(v => /\d/.test(v));
      if (montoStr) {
        const monto = parseFloat(montoStr.replace(/[^\d.]/g, ''));
        if (!isNaN(monto)) total += monto;
      }
    }
  }

  return {
    infracciones: filas.filter(f => f.some(v => /infracc/i.test(v))),
    tenencia: filas.filter(f => f.some(v => /tenen/i.test(v))),
    total: total,
    filas: filas
  };
}

// ============================================
// COTIZACION
// ============================================
function cotizarServicio(repuve, adeudos) {
  const PRECIO = 700;
  let adeudosTotal = 0;
  if (adeudos.tieneAdeudos && adeudos.adeudos) adeudosTotal = adeudos.adeudos.total || 0;

  if (repuve.estatusRobo === 'CON REPORTE DE ROBO') {
    return { verificable: false, mensaje: 'Vehiculo con reporte de robo activo.', cotizacion_servicio: null };
  }

  const bloqueado = repuve.estatusRobo === 'SERVICIO_DISPONIBLE';
  const total = PRECIO + adeudosTotal;

  return {
    verificable: true,
    repuve_bloqueado: bloqueado,
    mensaje: adeudosTotal > 0 ? `Verificable. $${adeudosTotal.toFixed(2)} MXN en adeudos.` : 'Verificable. Sin adeudos.',
    cotizacion_servicio: {
      disponible: true,
      desglose: { servicio_verificacion: PRECIO, adeudos_a_pagar: adeudosTotal, total: total },
      resumen: adeudosTotal > 0 ? `Verificacion + adeudos: $${total.toFixed(2)} MXN` : `Verificacion: $${PRECIO.toFixed(2)} MXN`,
      nota: bloqueado ? 'El servicio incluye consulta REPUVE completa.' : null
    }
  };
}

// ============================================
// CHATBOT
// ============================================
function procesarMensaje(mensaje, sesion_id) {
  const msg = mensaje.toLowerCase().trim();
  let respuesta = '';
  let categoria = 'general';
  let confianza = 0.8;
  let sugerencias = [];

  if (msg.includes('precio') || msg.includes('cuesta') || msg.includes('cuanto') || msg.includes('cost')) {
    categoria = 'precio';
    confianza = 0.95;
    respuesta = 'El servicio de verificacion a domicilio cuesta $700 MXN.\n\nEste precio incluye:\n- Consulta REPUVE completa (reporte de robo)\n- Verificacion sin que lleves tu auto\n- Reporte oficial del estado legal de tu vehiculo\n\nSi tu auto tiene adeudos (infracciones o tenencia), esos se pagan aparte. El precio exacto te lo damos despues de consultar tu placa.';
    sugerencias = ['Como funciona', 'Consultar mi placa', 'Contactar WhatsApp'];
  } else if (msg.includes('como funciona') || msg.includes('proceso') || msg.includes('pasos')) {
    categoria = 'proceso';
    confianza = 0.95;
    respuesta = 'Es muy sencillo, 3 pasos:\n\n1. Nos das tu placa (o escaneas tu tarjeta de circulacion)\n2. Consultamos REPUVE y Finanzas CDMX\n3. Te entregamos reporte completo + cotizacion\n\nSi aceptas, vamos a tu domicilio a hacer la verificacion. Tu auto no se mueve.';
    sugerencias = ['Cuanto cuesta', 'Consultar mi placa', 'Contactar WhatsApp'];
  } else if (msg.includes('placa') || msg.includes('consultar') || msg.includes('verificar') || msg.includes('buscar')) {
    categoria = 'consulta';
    confianza = 0.9;
    respuesta = 'Para consultar tu vehiculo solo ingresa tu placa en el campo de busqueda arriba.\n\nPuedes escribirla directamente (ej: ABC1234) o usar el boton de "Escanear tarjeta de circulacion" para que la detectemos automaticamente con una foto.';
    sugerencias = ['Cuanto cuesta', 'Que datos me dan'];
  } else if (msg.includes('repuve') || msg.includes('robo') || msg.includes('robado')) {
    categoria = 'repuve';
    confianza = 0.9;
    respuesta = 'REPUVE es el Registro Publico Vehicular del gobierno de Mexico.\n\nAhi se registra si un auto tiene reporte de robo activo. Es la consulta mas importante antes de comprar o verificar cualquier vehiculo.\n\nNosotros consultamos REPUVE en tiempo real y te decimos el estatus legal de tu auto.';
    sugerencias = ['Consultar mi placa', 'Que mas verifican'];
  } else if (msg.includes('adeudo') || msg.includes('multa') || msg.includes('infracci') || msg.includes('tenencia')) {
    categoria = 'adeudos';
    confianza = 0.9;
    respuesta = 'Verificamos adeudos ante Finanzas CDMX:\n\n- Infracciones de transito pendientes\n- Tenencia vencida\n- Fotocivicas\n\nSi encuentras adeudos, te decimos el monto exacto y puedes incluir el pago en el servicio GIV.';
    sugerencias = ['Cuanto cuesta', 'Consultar mi placa'];
  } else if (msg.includes('whatsapp') || msg.includes('contacto') || msg.includes('hablar') || msg.includes('asesor')) {
    categoria = 'contacto';
    confianza = 0.95;
    respuesta = 'Puedes contactarnos por WhatsApp:\n\n📱 52 1 56 6095 1415\n\nAhi te atiende nuestro equipo para agendar tu servicio de verificacion o resolver cualquier duda.';
    sugerencias = ['Cuanto cuesta', 'Como funciona'];
  } else if (msg.includes('gracias') || msg.includes('ok') || msg.includes('bien') || msg.includes('perfecto')) {
    categoria = 'cierre';
    confianza = 0.8;
    respuesta = 'Cuando gustes! Recuerda que estamos para ayudarte con la verificacion de tu vehiculo. 🚗';
    sugerencias = ['Consultar mi placa', 'Contactar WhatsApp'];
  } else if (msg.includes('horario') || msg.includes('hora') || msg.includes('cuando')) {
    categoria = 'horario';
    confianza = 0.85;
    respuesta = 'Nuestro servicio a domicilio esta disponible:\n\nLunes a Viernes: 9:00 AM - 7:00 PM\nSabados: 9:00 AM - 3:00 PM\n\nLas consultas en linea funcionan 24/7.';
    sugerencias = ['Contactar WhatsApp', 'Cuanto cuesta'];
  } else if (msg.includes('zona') || msg.includes('donde') || msg.includes('cobertura') || msg.includes('domicilio')) {
    categoria = 'cobertura';
    confianza = 0.85;
    respuesta = 'Damos servicio a domicilio en:\n\n- CDMX (todas las alcaldias)\n- Estado de Mexico (zonas conurbadas)\n\nSi estas en otra zona, contactanos por WhatsApp para verificar disponibilidad.';
    sugerencias = ['Cuanto cuesta', 'Contactar WhatsApp'];
  } else if (msg.includes('que datos') || msg.includes('que informacion') || msg.includes('reporte')) {
    categoria = 'info';
    confianza = 0.9;
    respuesta = 'Tu reporte incluye TODA la informacion del vehiculo:\n\n- Estatus de robo (REPUVE)\n- Marca, modelo, año\n- NIV / Numero de serie\n- Entidad de emplacado\n- Infracciones pendientes\n- Adeudos de tenencia\n- Observaciones del registro';
    sugerencias = ['Consultar mi placa', 'Cuanto cuesta'];
  } else {
    categoria = 'default';
    confianza = 0.5;
    respuesta = 'Soy el asistente virtual de GIV. Puedo ayudarte con:\n\n- Precios del servicio\n- Como funciona la verificacion\n- Consultar tu placa\n- Dudas sobre REPUVE o adeudos\n- Contacto con un asesor\n\n¿En que te ayudo?';
    sugerencias = ['Cuanto cuesta', 'Como funciona', 'Consultar mi placa', 'Contactar WhatsApp'];
  }

  return { respuesta, categoria, confianza, sugerencias };
}

// ============================================
// ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Consulta completa (REPUVE + Adeudos + Cotizacion + Guardado en Supabase)
app.post('/api/verificacion-completa', async (req, res) => {
  const { placa } = req.body;
  if (!placa || placa.length < 3) return res.status(400).json({ error: 'Placa invalida' });

  const [repuve, adeudos] = await Promise.all([
    consultarRepuve(placa),
    consultarAdeudosCDMX(placa)
  ]);

  const cotizacion = cotizarServicio(repuve, adeudos);
  const placaLimpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const folio = `GIV-${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}-${Date.now().toString().slice(-5)}`;

  const resultado = {
    success: true, placa: placaLimpia,
    repuve, adeudos, cotizacion, folio,
    timestamp: new Date().toISOString()
  };

  // Guardar en Supabase
  try {
    const { error } = await supabase.from('consultas').insert({
      folio,
      placa: placaLimpia,
      repuve_estatus: repuve.estatusRobo,
      repuve_datos: repuve.datos,
      repuve_error: repuve.error || null,
      adeudos_tiene: adeudos.tieneAdeudos,
      adeudos_total: adeudos.totalAdeudos,
      adeudos_detalle: adeudos.adeudos,
      cotizacion_verificable: cotizacion.verificable,
      cotizacion_total: cotizacion.cotizacion_servicio?.total || 0,
      created_at: new Date().toISOString()
    });
    if (error) console.error('[SUPABASE] Error guardando:', error.message);
  } catch (e) {
    console.error('[SUPABASE] Exception:', e.message);
  }

  res.json(resultado);
});

// Solo REPUVE
app.get('/api/repuve/:placa', async (req, res) => {
  const resultado = await consultarRepuve(req.params.placa);
  res.json(resultado);
});

// Solo Adeudos CDMX
app.get('/api/adeudos/:placa', async (req, res) => {
  const resultado = await consultarAdeudosCDMX(req.params.placa);
  res.json(resultado);
});

// Estadisticas (desde Supabase)
app.get('/api/estadisticas', async (req, res) => {
  try {
    const { count: total } = await supabase
      .from('consultas')
      .select('*', { count: 'exact', head: true });

    const hoy = new Date().toISOString().split('T')[0];
    const { count: hoyCount } = await supabase
      .from('consultas')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', hoy);

    res.json({
      total_consultas: total || 0,
      consultas_hoy: hoyCount || 0
    });
  } catch (error) {
    res.json({ total_consultas: 0, consultas_hoy: 0, error: error.message });
  }
});

// Listar consultas (para panel administrativo)
app.get('/api/consultas', async (req, res) => {
  try {
    const { limite = 50, pagina = 1 } = req.query;
    const inicio = (pagina - 1) * parseInt(limite);
    const fin = inicio + parseInt(limite) - 1;

    const { data, error, count } = await supabase
      .from('consultas')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(inicio, fin);

    if (error) return res.status(500).json({ error: error.message });

    res.json({
      total: count || 0,
      pagina: parseInt(pagina),
      limite: parseInt(limite),
      consultas: data || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener consulta por folio
app.get('/api/consultas/:folio', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('consultas')
      .select('*')
      .eq('folio', req.params.folio)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Folio no encontrado' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// OCR — Tarjeta de Circulacion
app.post('/api/ocr', upload.single('tarjeta'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibio ninguna imagen' });
  }

  try {
    const procesada = await preprocesarImagen(req.file.buffer);
    const worker = await createWorker('spa', 1);
    await worker.setParameters({ tessedit_char_whitelist: '' });
    const { data: { text } } = await worker.recognize(procesada);
    await worker.terminate();

    const campos = parsearTarjetaCirculacion(text);

    res.json({
      success: true,
      campos: campos,
      texto_completo: text.substring(0, 2000),
      mensaje: campos.placa
        ? `Detectamos la placa ${campos.placa}. Puedes verificar ahora.`
        : 'No detectamos la placa automaticamente. Ingresala manualmente.'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al procesar la imagen', detalle: error.message });
  }
});

// Chatbot
app.post('/api/chat', (req, res) => {
  const { mensaje, sesion_id } = req.body;
  if (!mensaje || typeof mensaje !== 'string') {
    return res.status(400).json({ error: 'Mensaje requerido' });
  }
  const resultado = procesarMensaje(mensaje, sesion_id);
  res.json({
    success: true,
    respuesta: resultado.respuesta,
    categoria: resultado.categoria,
    confianza: resultado.confianza,
    sugerencias: resultado.sugerencias
  });
});

// Sugerencias rapidas chatbot
app.get('/api/chat/sugerencias', (req, res) => {
  res.json({
    sugerencias: [
      { texto: '¿Cuánto cuesta?', icono: '💰' },
      { texto: '¿Cómo funciona?', icono: '🚗' },
      { texto: 'Consultar mi placa', icono: '🛡️' },
      { texto: 'Contactar WhatsApp', icono: '📱' }
    ]
  });
});

// Panel Admin — Resumen
app.get('/api/admin/resumen', async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const hace7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Total consultas
    const { count: totalConsultas } = await supabase
      .from('consultas').select('*', { count: 'exact', head: true });

    // Consultas hoy
    const { count: consultasHoy } = await supabase
      .from('consultas').select('*', { count: 'exact', head: true })
      .gte('created_at', hoy);

    // Consultas 7 dias
    const { data: consultas7d } = await supabase
      .from('consultas').select('cotizacion_total')
      .gte('created_at', hace7d);

    // Con adeudos
    const { count: conAdeudos } = await supabase
      .from('consultas').select('*', { count: 'exact', head: true })
      .eq('adeudos_tiene', true);

    // Placas sospechosas (5+ consultas)
    const { data: todasPlacas } = await supabase
      .from('consultas').select('placa');

    const placasCount = {};
    (todasPlacas || []).forEach(c => {
      const p = c.placa.toUpperCase();
      if (!placasCount[p]) placasCount[p] = 0;
      placasCount[p]++;
    });

    const placasSuspiciosas = Object.entries(placasCount)
      .filter(([placa, count]) => count >= 5 && placa !== '')
      .map(([placa, count]) => ({ placa, consultas: count }))
      .sort((a, b) => b.consultas - a.consultas)
      .slice(0, 20);

    // Ultimas consultas
    const { data: ultimas } = await supabase
      .from('consultas')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);

    const cotizacionTotal7d = (consultas7d || []).reduce((s, c) => s + (c.cotizacion_total || 0), 0);

    res.json({
      general: {
        total_consultas: totalConsultas || 0,
        consultas_hoy: consultasHoy || 0,
        consultas_7d: consultas7d?.length || 0,
        con_adeudos: conAdeudos || 0,
        cotizacion_total_7d: cotizacionTotal7d
      },
      fraude: {
        placas_suspiciosas: placasSuspiciosas,
        alertas: placasSuspiciosas.length > 0 ?
          `${placasSuspiciosas.length} placa(s) con 5+ consultas (posible intento de evasion)` :
          'Sin alertas'
      },
      actividad_reciente: (ultimas || []).map(c => ({
        folio: c.folio,
        placa: c.placa,
        fecha: c.created_at,
        verificable: c.cotizacion_verificable,
        servicio_giv: c.cotizacion_total
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin — Consultas por placa
app.get('/api/admin/placa/:placa', async (req, res) => {
  try {
    const placa = req.params.placa.toUpperCase();
    const { data, error } = await supabase
      .from('consultas')
      .select('*')
      .eq('placa', placa)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const historial = (data || []).map(c => ({
      folio: c.folio,
      fecha: c.created_at,
      repuve: c.repuve_estatus,
      adeudos: c.adeudos_total,
      verificable: c.cotizacion_verificable,
      servicio_giv: c.cotizacion_total
    }));

    res.json({
      placa: placa,
      total_consultas: historial.length,
      historial: historial,
      riesgo: historial.length >= 10 ? 'ALTO' : historial.length >= 5 ? 'MEDIO' : historial.length >= 3 ? 'BAJO' : 'MINIMO'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ruta por defecto - servir index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

module.exports = app;
