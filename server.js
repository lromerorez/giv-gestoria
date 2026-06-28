const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { createWorker } = require('tesseract.js');
const { Jimp, JimpMime } = require('jimp');
const { procesarMensaje } = require('./chatbot');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// OCR — Tarjeta de Circulacion
// ============================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imagenes (JPEG, PNG, WEBP, GIF)'));
    }
  }
});

// Preprocesar imagen para mejor OCR usando Jimp v1
async function preprocesarImagen(buffer) {
  const image = await Jimp.read(buffer);
  
  // Redimensionar a max 1800px de ancho
  if (image.bitmap.width > 1800) {
    image.resize({ w: 1800 });
  }
  
  // Escala de grises + contraste + brillo
  image.greyscale();
  image.contrast(0.3);
  image.brightness(0.05);
  
  // Obtener buffer PNG
  return await image.getBuffer(JimpMime.png);
}

// Parsear texto extraido para encontrar campos de la tarjeta
function parsearTarjetaCirculacion(texto) {
  const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const fullText = texto.toUpperCase();
  
  const resultado = {
    placa: null,
    niv: null,
    vin: null,
    nombre: null,
    marca: null,
    modelo: null,
    anio: null,
    cilindros: null,
    puertas: null,
    combustible: null,
    entidad: null,
    municipio: null,
    raw: lineas.slice(0, 30)
  };

  // PLACA: multiples formatos mexicanos
  // CDMX: ABC-1234 o ABC1234, Edomex: 123-ABC-123, etc.
  const placaPatrones = [
    /\b([A-Z]{3}[-]?[0-9]{3,4})\b/i,       // ABC-1234, ABC1234 (CDMX)
    /\b([0-9]{3}[-]?[A-Z]{3}[-]?[0-9]{0,3})\b/i, // 123-ABC Edomex
    /\b([A-Z][0-9]{3}[A-Z]{2})\b/i,          // A123BC (fronteriza antigua)
    /\b(PLACA[S]?[:\s]+([A-Z0-9\-]{4,}))/i, // etiqueta PLACA:
  ];
  
  for (const patron of placaPatrones) {
    const match = fullText.match(patron);
    if (match) {
      const placa = (match[2] || match[1]).replace(/[\s\-]/g, '').toUpperCase();
      // Validar longitud minima
      if (placa.length >= 5 && placa.length <= 9) {
        resultado.placa = placa;
        break;
      }
    }
  }

  // NIV/VIN: 17 caracteres alfanumericos (sin I, O, Q)
  const nivRegex = /\b([A-HJ-NPR-Z0-9]{17})\b/ig;
  const nivMatches = [...fullText.matchAll(nivRegex)];
  for (const m of nivMatches) {
    const candidato = m[1].toUpperCase();
    // Debe tener al menos 2 letras y 2 numeros para ser un NIV valido
    const letras = (candidato.match(/[A-HJ-NPR-Z]/g) || []).length;
    const numeros = (candidato.match(/[0-9]/g) || []).length;
    if (letras >= 2 && numeros >= 2) {
      resultado.niv = candidato;
      resultado.vin = candidato;
      break;
    }
  }

  // Buscar NIV por etiqueta
  if (!resultado.niv) {
    for (const linea of lineas) {
      const m = linea.match(/(?:NIV|VIN|NO\s*SERIE)[:\s]*([A-HJ-NPR-Z0-9]{12,})/i);
      if (m) { resultado.niv = m[1].toUpperCase(); resultado.vin = resultado.niv; break; }
    }
  }

  // MODELO/AÑO: buscar año (4 digitos entre 1980-2030)
  const anioRegex = /\b(19[89]\d|20[0-3]\d)\b/;
  const anioMatch = fullText.match(anioRegex);
  if (anioMatch) resultado.anio = anioMatch[0];

  // MARCA
  const marcas = ['TOYOTA','HONDA','NISSAN','CHEVROLET','FORD','VW','VOLKSWAGEN','MAZDA','KIA','HYUNDAI','BMW','MERCEDES','AUDI','JEEP','DODGE','GMC','CHEVY','CHRYSLER','SEAT','RENAULT','MITSUBISHI','SUBARU','SUZUKI','FIAT','PORSCHE','LAND ROVER','JAGUAR','MINI','TESLA','FIAT','BUICK','CADILLAC','INFINITY','INFINITI','ACURA','LEXUS','LINCOLN','RAM','MCLAREN','ALFA ROMEO','BYD','MG','SEAT'];
  for (const marca of marcas) {
    if (fullText.includes(marca)) {
      resultado.marca = marca.charAt(0) + marca.slice(1).toLowerCase();
      break;
    }
  }

  // MODELO: buscar etiqueta MODELO:, o linea que tenga MARCA + otra palabra
  for (const linea of lineas) {
    const m = linea.match(/(?:MODELO|VEHICULO|VEHÍCULO|TIPO)[:\s]+([A-Za-z0-9][A-Za-z0-9\s]*)/i);
    if (m && m[1].trim().length >= 2) {
      const candidato = m[1].trim();
      // No aceptar si la palabra es otra etiqueta
      if (!/^(MARCA|NIV|ANO|PLACA|NOMBRE|ENTIDAD|CILINDROS|PUERTAS|TENENCIA|MODELO)$/i.test(candidato)) {
        resultado.modelo = candidato;
        break;
      }
    }
    // Buscar: "MARCA TOYOTA MODELO COROLLA" en misma linea
    if (resultado.marca && linea.toUpperCase().includes(resultado.marca.toUpperCase()) && !linea.match(/MODELO|TIPO/i)) {
      const partes = linea.split(/\s+/);
      const idxMarca = partes.findIndex(p => p.toUpperCase() === resultado.marca.toUpperCase());
      if (idxMarca >= 0 && idxMarca < partes.length - 1) {
        const modeloPart = partes.slice(idxMarca + 1).join(' ');
        if (modeloPart.length >= 2 && modeloPart.length < 25) {
          resultado.modelo = modeloPart;
          break;
        }
      }
    }
  }

  // NOMBRE del titular
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(/(?:NOMBRE|PROPIETARIO|TITULAR|NAME)[:\s]*([A-Za-zÀ-ÿ\s\.]{5,})/i);
    if (m) {
      resultado.nombre = m[1].trim().replace(/\s+/g, ' ');
      break;
    }
  }

  // ENTIDAD/ESTADO
  const estados = ['CDMX','ESTADO DE MEXICO','JALISCO','NUEVO LEON','VERACRUZ','GUANAJUATO','PUEBLA','CHIAPAS','MICHOACAN','OAXACA','TABASCO','SINALOA','GUERRERO','TAMAULIPAS','COAHUILA','HIDALGO','SAN LUIS POTOSI','QUERETARO','YUCATAN','QUINTANA ROO','SONORA','DURANGO','ZACATECAS','NAYARIT','COLIMA','AGUASCALIENTES','MORELOS','CAMPECHE','BAJA CALIFORNIA','BCS'];
  for (const estado of estados) {
    if (fullText.includes(estado)) {
      resultado.entidad = estado;
      break;
    }
  }

  // CILINDROS
  for (const linea of lineas) {
    const m = linea.match(/(?:CILINDROS|CIL|Motor|cilindrada)[:\s]*(\d)/i);
    if (m) { resultado.cilindros = m[1]; break; }
  }

  // PUERTAS
  for (const linea of lineas) {
    const m = linea.match(/(?:PUERTAS)[:\s]*(\d)/i);
    if (m) { resultado.puertas = m[1]; break; }
  }

  return resultado;
}

// Endpoint OCR
app.post('/api/ocr', upload.single('tarjeta'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se recibio ninguna imagen' });
  }

  console.log(`[OCR] Procesando imagen: ${req.file.originalname} (${req.file.size} bytes)`);
  
  try {
    // Preprocesar imagen
    const procesada = await preprocesarImagen(req.file.buffer);
    
    // Ejecutar Tesseract
    const worker = await createWorker('spa', 1);
    await worker.setParameters({
      tessedit_char_whitelist: '', // Todos los caracteres
    });
    
    const { data: { text } } = await worker.recognize(procesada);
    await worker.terminate();
    
    console.log(`[OCR] Texto detectado (${text.length} chars)`);
    
    // Parsear campos
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
    console.error('[OCR] Error:', error.message);
    res.status(500).json({ 
      error: 'Error al procesar la imagen',
      detalle: error.message 
    });
  }
});

// ============================================

// ============================================
// BASE DE DATOS LOCAL (JSON)
// ============================================
const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'consultas.json');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ consultas: [], contador: 0 }, null, 2));
}

function leerDB() {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { consultas: [], contador: 0 };
  }
}

function guardarDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function generarFolio(contador) {
  const fecha = new Date();
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const secuencia = String(contador + 1).padStart(5, '0');
  return `GIV-${anio}${mes}-${secuencia}`;
}

function guardarConsulta(datos) {
  const db = leerDB();
  db.contador += 1;
  
  const cotizacion = datos.cotizacion;
  const servicioTotal = cotizacion?.cotizacion_servicio?.desglose?.total || 0;

  const registro = {
    folio: generarFolio(db.contador),
    fecha_consulta: new Date().toISOString(),
    placa: datos.placa || '',
    repuve: {
      estatus_robo: datos.repuve?.estatusRobo || 'NO VERIFICABLE',
      error: datos.repuve?.error || null,
      datos: datos.repuve?.datos || null,
      // Campos parseados del HTML REPUVE
      marca: datos.repuve?.datos?.marca || null,
      modelo: datos.repuve?.datos?.modelo || null,
      anio: datos.repuve?.datos?.anio || null,
      niv: datos.repuve?.datos?.niv || null,
      clase: datos.repuve?.datos?.clase || null,
      tipo: datos.repuve?.datos?.tipo || null,
      placa: datos.repuve?.datos?.placa || null,
      entidad: datos.repuve?.datos?.entidad || null,
      // Datos extendidos del HTML (los que viste)
      puertas: datos.repuve?.datos?.puertas || null,
      pais_origen: datos.repuve?.datos?.pais_origen || null,
      version: datos.repuve?.datos?.version || null,
      cilindros: datos.repuve?.datos?.cilindros || null,
      planta_ensamble: datos.repuve?.datos?.planta_ensamble || null,
      institucion: datos.repuve?.datos?.institucion || null,
      fecha_inscripcion: datos.repuve?.datos?.fecha_inscripcion || null,
      fecha_emplacado: datos.repuve?.datos?.fecha_emplacado || null
    },
    adeudos: {
      tiene_adeudos: datos.adeudos?.tieneAdeudos || false,
      total: datos.adeudos?.totalAdeudos || 0,
      detalle: datos.adeudos?.adeudos || null
    },
    cotizacion: {
      verificable: cotizacion?.verificable || false,
      servicio_giv: servicioTotal
    }
  };
  
  db.consultas.unshift(registro);
  guardarDB(db);
  
  console.log(`[DB] Guardado: ${registro.folio} — ${registro.placa} — Servicio GIV: $${servicioTotal}`);
  return registro;
}

// ============================================
// REPUVE SCRAPER — Consulta gratuita
// ============================================
async function consultarRepuve(placa) {
  const placaLimpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const http = require('http');
  
  try {
    // Hacer POST directo al servlet de consulta REPUVE
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
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
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

    // Detectar si REPUVE devolvio error 503 (WebLogic bloquea desde IP no autorizada)
    if (html.includes('Error 503') || html.includes('Service Unavailable')) {
      return {
        placa: placaLimpia,
        fuente: 'REPUVE',
        fechaConsulta: new Date().toISOString(),
        estatusRobo: 'SERVICIO_DISPONIBLE',
        error: 'REPUVE no disponible desde este servidor. La consulta de robo se realizará manualmente al procesar tu verificación.',
        datos: null
      };
    }
    
    // Detectar si tiene reporte de robo
    const tieneRobo = html.includes('REPORTE DE ROBO') || html.includes('reporte de robo');
    const sinRobo = html.includes('SIN REPORTE DE ROBO') || html.includes('Sin reporte de robo');
    
    // Extraer datos basicos del HTML
    const datos = extraerDatosRepuve(html);
    
    return {
      placa: placaLimpia,
      fuente: 'REPUVE',
      fechaConsulta: new Date().toISOString(),
      estatusRobo: sinRobo ? 'SIN REPORTE' : (tieneRobo ? 'CON REPORTE DE ROBO' : 'NO VERIFICABLE'),
      datos: datos,
      raw: html.substring(0, 500)
    };

  } catch (error) {
    return {
      placa: placaLimpia,
      fuente: 'REPUVE',
      fechaConsulta: new Date().toISOString(),
      estatusRobo: 'ERROR',
      error: error.message,
      datos: null
    };
  }
}

function extraerDatosRepuve(html) {
  const datos = {};
  const txt = html.toUpperCase();
  
  // Estatus de robo (prioritario)
  if (html.includes('SIN REPORTE DE ROBO') || html.includes('Sin reporte de robo')) {
    datos.estatusRobo = 'SIN REPORTE';
  } else if (html.includes('REPORTE DE ROBO') || html.includes('reporte de robo')) {
    datos.estatusRobo = 'CON REPORTE DE ROBO';
  } else if (html.includes('Error 503') || html.includes('Service Unavailable')) {
    datos.estatusRobo = 'SERVICIO_NO_DISPONIBLE';
  } else {
    datos.estatusRobo = 'NO VERIFICABLE';
  }

  // Funcion helper para extraer etiqueta:valor de tabla HTML
  function extraer(etiquetas) {
    for (const etiqueta of etiquetas) {
      // Patron  VALOR
      const regex1 = new RegExp(etiqueta + '[^<]*<\\/td>\\s*<td[^>]*>([^<]+)', 'i');
      const m1 = html.match(regex1);
      if (m1) return m1[1].trim();
      
      // Patron etiqueta: valor (texto plano)
      const sep = '[:\\s]+';
      const regex2 = new RegExp(etiqueta + sep + '([A-Za-z0-9\\s\\-\\./\\(\\)#,]+)', 'i');
      const m2 = html.match(regex2);
      if (m2 && m2[1].trim().length > 1) return m2[1].trim();
    }
    return null;
  }
  
  // Campos basados en la estructura REAL del HTML que nos pasaste
  datos.marca = extraer(['Marca']);
  datos.modelo = extraer(['Modelo', 'VERSION']);
  datos.anio = extraer(['Año Modelo', 'ANO MODELO', 'ANO']) || extraer(['AÑO MODELO']);
  datos.niv = extraer(['NIV', 'Numero de Identificacion Vehicular \\(NIV\\)', 'NUMERO DE IDENTIFICACION VEHICULAR']);
  datos.clase = extraer(['Clase']);
  datos.tipo = extraer(['Tipo']);
  datos.placa = extraer(['Placa', 'PLACAS']);
  datos.entidad = extraer(['Entidad que emplaco', 'ENTIDAD QUE EMPLACO', 'Entidad']);
  datos.puertas = extraer(['Numero de puertas', 'Numero de Puertias', 'PUERTAS']);
  datos.pais_origen = extraer(['Pais de origen', 'PAIS DE ORIGEN']);
  datos.version = extraer(['Version', 'VERSION S']);
  datos.cilindros = extraer(['Numero de cilindros', 'NUMERO DE CILINDROS', 'CILINDROS']) || extraer(['Desplazamiento \\(cc\\/L\\) ']);
  datos.planta_ensamble = extraer(['Planta de ensamble', 'PLANTA DE ENSAMBLE']);
  datos.institucion = extraer(['Institucion que lo inscribio', 'INSTITUCION QUE LO INSCRIBIO', 'Institucion']);
  datos.fecha_inscripcion = extraer(['Fecha de inscripcion', 'FECHA DE INSCRIPCION']);
  datos.fecha_emplacado = extraer(['Fecha de emplacado', 'FECHA DE EMPLACADO']);
  datos.fecha_actualizacion = extraer(['Fecha de ultima actualizacion', 'FECHA DE ULTIMA ACTUALIZACION']);
  datos.folio_constancia = extraer(['Folio de Constancia de Inscripcion', 'FOLIO DE CONSTANCIA DE INSCRIPCION']);
  datos.nci = extraer(['Numero de Constancia de Inscripcion \\(NCI\\)', 'NCI']);
  datos.observaciones = extraer(['Observaciones']);
  datos.desplazamiento = extraer(['Desplazamiento \\(cc\\/L\\) ']);
  datos.raw_complementarios = extraer(['Datos complementarios', 'DATOS COMPLEMENTARIOS']);

  // Limpiar nulls
  Object.keys(datos).forEach(k => { if (datos[k] === null || datos[k] === undefined) delete datos[k]; });
  
  return Object.keys(datos).length > 1 ? datos : { estatusRobo: datos.estatusRobo };
}

// ============================================
// ADEUDOS CDMX SCRAPER
// ============================================
async function consultarAdeudosCDMX(placa) {
  const placaLimpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  try {
    const https = require('https');
    const http = require('http');
    
    // Portal de adeudos CDMX - formulario POST
    const postData = `placa=${placaLimpia}`;
    
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'data.finanzas.cdmx.gob.mx',
        port: 443,
        path: '/consulta_adeudos',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        },
        rejectUnauthorized: false,
        timeout: 15000
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

    const html = result.toString();
    
    // Parsear adeudos
    const adeudos = parsearAdeudos(html);
    
    return {
      placa: placaLimpia,
      fuente: 'Finanzas CDMX',
      fechaConsulta: new Date().toISOString(),
      adeudos: adeudos,
      tieneAdeudos: adeudos ? adeudos.total > 0 : false,
      totalAdeudos: adeudos ? adeudos.total : 0
    };

  } catch (error) {
    return {
      placa: placaLimpia,
      fuente: 'Finanzas CDMX',
      fechaConsulta: new Date().toISOString(),
      error: error.message,
      adeudos: null,
      tieneAdeudos: false,
      totalAdeudos: 0
    };
  }
}

function parsearAdeudos(html) {
  // Buscar tabla de adeudos en el HTML
  const tieneInfracciones = html.includes('NO PAGADA') || html.includes('infracci');
  const tieneTenencia = html.includes('tenencia') || html.includes('Tenencia');
  
  // Extraer filas de la tabla de adeudos
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
      // Intentar extraer monto
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
// API ENDPOINTS
// ============================================

// Consulta completa (REPUVE + Adeudos + Cotizacion + Guardado en DB)
app.post('/api/verificacion-completa', async (req, res) => {
  const { placa } = req.body;
  
  if (!placa || placa.length < 3) {
    return res.status(400).json({ error: 'Placa invalida' });
  }
  
  console.log(`[CONSULTA] Placa: ${placa}`);
  
  const [repuve, adeudos] = await Promise.all([
    consultarRepuve(placa).catch(e => ({ placa: placa, fuente: 'REPUVE', error: e.message || 'Error desconocido', estatusRobo: 'ERROR' })),
    consultarAdeudosCDMX(placa).catch(e => ({ placa: placa, fuente: 'Finanzas CDMX', error: e.message || 'Error desconocido', tieneAdeudos: false, totalAdeudos: 0, adeudos: null }))
  ]);
  
  // Calcular cotizacion
  const cotizacion = cotizarServicio(repuve, adeudos);
  
  const resultado = {
    success: true,
    placa: placa.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    repuve: repuve,
    adeudos: adeudos,
    cotizacion: cotizacion,
    timestamp: new Date().toISOString()
  };
  
  // Guardar en base de datos local
  const registro = guardarConsulta(resultado);
  resultado.folio = registro.folio;
  resultado.registro = registro;
  
  res.json(resultado);
});

// Listar todas las consultas (para panel administrativo)
app.get('/api/consultas', (req, res) => {
  const db = leerDB();
  const { limite = 50, pagina = 1 } = req.query;
  const inicio = (pagina - 1) * limite;
  const fin = inicio + parseInt(limite);
  
  res.json({
    total: db.consultas.length,
    pagina: parseInt(pagina),
    limite: parseInt(limite),
    consultas: db.consultas.slice(inicio, fin)
  });
});

// Obtener consulta por folio
app.get('/api/consultas/:folio', (req, res) => {
  const db = leerDB();
  const consulta = db.consultas.find(c => c.folio === req.params.folio);
  
  if (!consulta) {
    return res.status(404).json({ error: 'Folio no encontrado' });
  }
  
  res.json(consulta);
});

// Estadisticas
app.get('/api/estadisticas', (req, res) => {
  const db = leerDB();
  const hoy = new Date().toISOString().split('T')[0];
  
  const hoyConsultas = db.consultas.filter(c => c.fecha_consulta.startsWith(hoy));
  const totalAdeudos = db.consultas.reduce((sum, c) => sum + c.adeudos.total, 0);
  const totalCotizaciones = db.consultas.reduce((sum, c) => sum + c.cotizacion.total, 0);
  
  res.json({
    total_consultas: db.consultas.length,
    consultas_hoy: hoyConsultas.length,
    adeudos_totales_consultados: totalAdeudos,
    cotizaciones_totales: totalCotizaciones,
    con_adeudos: db.consultas.filter(c => c.adeudos.tiene_adeudos).length,
    sin_adeudos: db.consultas.filter(c => !c.adeudos.tiene_adeudos).length
  });
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

// Cotizacion
function cotizarServicio(repuve, adeudos) {
  const PRECIO_VERIFICACION = 700;
  let adeudosTotal = 0;
  let adeudosDetalle = { infracciones: [], tenencia: [] };

  if (adeudos.tieneAdeudos && adeudos.adeudos) {
    adeudosTotal = adeudos.adeudos.total || 0;
    adeudosDetalle = {
      infracciones: adeudos.adeudos.infracciones || [],
      tenencia: adeudos.adeudos.tenencia || []
    };
  }

  // Con reporte de robo: no verificable, sin cotizacion
  if (repuve.estatusRobo === 'CON REPORTE DE ROBO') {
    return {
      verificable: false,
      mensaje: 'Vehiculo con reporte de robo activo. Requiere denuncia para levantar.',
      adeudos: { total: adeudosTotal, ...adeudosDetalle },
      cotizacion_servicio: null
    };
  }

  // REPUVE no disponible (red movil bloqueada): igual ofrecemos servicio
  const repuveBloqueado = repuve.estatusRobo === 'SERVICIO_DISPONIBLE' || repuve.estatusRobo === 'SERVICIO_NO_DISPONIBLE';

  // Verificable: mostrar resultados gratis + ofrecer servicio opcional
  const totalConServicio = PRECIO_VERIFICACION + adeudosTotal;

  return {
    verificable: true,
    repuve_bloqueado: repuveBloqueado,
    mensaje: adeudosTotal > 0
      ? `Vehiculo verificable. Tiene $${adeudosTotal.toFixed(2)} MXN en adeudos.`
      : 'Vehiculo verificable. Sin adeudos pendientes.',
    adeudos: { total: adeudosTotal, ...adeudosDetalle },
    cotizacion_servicio: {
      disponible: true,
      desglose: {
        servicio_verificacion: PRECIO_VERIFICACION,
        adeudos_a_pagar: adeudosTotal,
        total: totalConServicio
      },
      resumen: adeudosTotal > 0
        ? `Verificacion a domicilio + pago de adeudos: $${totalConServicio.toFixed(2)} MXN (incluye $${adeudosTotal.toFixed(2)} de adeudos)`
        : `Verificacion a domicilio: $${PRECIO_VERIFICACION.toFixed(2)} MXN`,
      nota: repuveBloqueado ? 'El servicio incluye consulta REPUVE completa al procesar tu tramite.' : null
    }
  };
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// INICIAR SERVIDOR (local) / EXPORTAR (Vercel)
// ============================================
const PORT = process.env.PORT || 3000;

if (!process.env.VERCEL) {
  // Solo escuchar si NO estamos en Vercel (serverless)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔═══════════════════════════════════════╗
  ║   GIV — Gestion Integral Vehicular   ║
  ║   Puerto: ${PORT}                         ║
  ║   Endpoints:                           ║
  ║   POST /api/verificacion-completa      ║
  ║   POST /api/ocr (upload tarjeta)       ║
  ║   POST /api/chat (chatbot)             ║
  ║   GET  /api/repuve/:placa              ║
  ║   GET  /api/adeudos/:placa             ║
  ║   GET  /api/consultas                  ║
  ║   GET  /api/estadisticas               ║
  ║   GET  /api/admin/resumen              ║
  ║   GET  /api/admin/placa/:placa         ║
  ╚═══════════════════════════════════════╝
  `);
  });
}

// ============================================
// CHATBOT — Asistente virtual GIV
// ============================================
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

// Sugerencias rapidas para el frontend (botones predefinidos)
app.get('/api/chat/sugerencias', (req, res) => {
  res.json({
    sugerencias: [
      { texto: '\u00bfCu\u00e1nto cuesta?', icono: '💰' },
      { texto: '\u00bfC\u00f3mo funciona?', icono: '🚗' },
      { texto: 'Consultar mi placa', icono: '🛡️' },
      { texto: 'Contactar WhatsApp', icono: '📱' }
    ]
  });
});

// ============================================
// PANEL ADMIN — Dashboard + Deteccion de Fraude
// ============================================
app.get('/api/admin/resumen', (req, res) => {
  const db = leerDB();
  const hoy = new Date().toISOString().split('T')[0];
  const hace7d = new Date(Date.now() - 7*24*60*60*1000).toISOString().split('T')[0];
  
  const consultasHoy = db.consultas.filter(c => c.fecha_consulta.startsWith(hoy));
  const consultas7d = db.consultas.filter(c => c.fecha_consulta >= hace7d);
  
  // Deteccion de fraude: placas consultadas multiples veces
  const placasCount = {};
  db.consultas.forEach(c => {
    const placa = c.placa.toUpperCase();
    if (!placasCount[placa]) placasCount[placa] = 0;
    placasCount[placa]++;
  });
  
  const placasSuspiciosas = Object.entries(placasCount)
    .filter(([placa, count]) => count >= 5 && placa !== '')
    .map(([placa, count]) => ({ placa, consultas: count }))
    .sort((a, b) => b.consultas - a.consultas)
    .slice(0, 20);
  
  // IPs/Actividad reciente (simulado — en prod seria por IP real)
  const ultimasConsultas = db.consultas.slice(0, 20).map(c => ({
    folio: c.folio,
    placa: c.placa,
    fecha: c.fecha_consulta,
    verificable: c.cotizacion.verificable,
    servicio_giv: c.cotizacion.servicio_giv
  }));
  
  res.json({
    general: {
      total_consultas: db.consultas.length,
      consultas_hoy: consultasHoy.length,
      consultas_7d: consultas7d.length,
      con_adeudos: db.consultas.filter(c => c.adeudos.tiene_adeudos).length,
      cotizacion_total_7d: consultas7d.reduce((s, c) => s + (c.cotizacion.servicio_giv || 0), 0)
    },
    fraude: {
      placas_suspiciosas: placasSuspiciosas,
      alertas: placasSuspiciosas.length > 0 ? 
        `${placasSuspiciosas.length} placa(s) con 5+ consultas (posible intento de evasion)` : 
        'Sin alertas'
    },
    actividad_reciente: ultimasConsultas
  });
});

// Consultas por placa (para investigar sospechosos)
app.get('/api/admin/placa/:placa', (req, res) => {
  const db = leerDB();
  const placa = req.params.placa.toUpperCase();
  const historial = db.consultas
    .filter(c => c.placa.toUpperCase() === placa)
    .map(c => ({
      folio: c.folio,
      fecha: c.fecha_consulta,
      repuve: c.repuve.estatus_robo,
      adeudos: c.adeudos.total,
      verificable: c.cotizacion.verificable,
      servicio_giv: c.cotizacion.servicio_giv
    }));
  
  res.json({
    placa: placa,
    total_consultas: historial.length,
    historial: historial,
    // Metricas de riesgo
    riesgo: historial.length >= 10 ? 'ALTO' : historial.length >= 5 ? 'MEDIO' : historial.length >= 3 ? 'BAJO' : 'MINIMO'
  });
});

module.exports = app;
