# AutoCheck MX — Verificacion Vehicular sin Llevar tu Auto

Plataforma web para ofrecer servicios de verificacion vehicular en Mexico (CDMX y Estado de Mexico).

## Modelo de Negocio

1. El cliente entra a la web e ingresa su placa
2. El sistema consulta REPUVE (robo) y Finanzas CDMX (infracciones/adeudos)
3. Muestra resultado + cotizacion para verificar SIN llevar el auto
4. Si el cliente acepta, procesa el pago y agenda la verificacion a domicilio
5. El cliente instala la PWA para consultas futuras (fidelizacion)

## Servicios ofrecidos

- **Reporte de Robo** (REPUVE)
- **Infracciones de Transito** (CDMX)
- **Adeudos de Tenencia** (CDMX)
- **Verificacion Vehicular a Domicilio** (sin llevar el auto)
- **Datos del Vehiculo** (marca, modelo, NIV, etc.)

## Estructura

```
autocheck-web/
├── server.js          # Backend + scrapers REPUVE/Finanzas
├── public/
│   ├── index.html     # Landing page + PWA
│   ├── sw.js          # Service Worker (offline/cache)
│   └── manifest.json  # PWA manifest (instalable)
├── deploy.sh          # Script de despliegue
└── .env.example       # Variables de entorno
```

## Requisitos

- Node.js 18+
- NPM
- **Servidor en la nube** (VPS) — NO funciona desde Termux/Android
  - REPUVE bloquea requests desde IPs residenciales/moviles
  - Se necesita IP de servidor (DigitalOcean, Vercel, etc.)

## Instalacion en servidor

```bash
git clone <tu-repo> autocheck-web
cd autocheck-web
npm install --production
cp .env.example .env
# Editar .env con tus datos
node server.js
```

## Configuracion (.env)

```env
PORT=3000
WHATSAPP_NUMERO=521XXXXXXXXXX
WHATSAPP_API_KEY=tu_api_key_aqui
APP_NAME=AutoCheck MX
CONTACTO_EMAIL=tu@email.com
```

## Despliegue con PM2 (recomendado)

```bash
npm install -g pm2
pm2 start server.js --name autocheck-mx
pm2 save
pm2 startup systemd
```

## Despliegue con Nginx (dominio propio)

```nginx
server {
    listen 80;
    server_name autocheck.mx;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Endpoints API

| Metodo | Endpoint | Descripcion |
|--------|----------|-------------|
| POST | `/api/verificacion-completa` | REPUVE + Adeudos + Cotizacion |
| GET | `/api/repuve/:placa` | Solo REPUVE |
| GET | `/api/adeudos/:placa` | Solo Adeudos CDMX |
| GET | `/api/health` | Estado del servidor |

### Ejemplo de consulta

```bash
curl -X POST http://localhost:3000/api/verificacion-completa \
  -H "Content-Type: application/json" \
  -d '{"placa": "ABC1234"}'
```

### Respuesta

```json
{
  "success": true,
  "placa": "ABC1234",
  "repuve": {
    "estatusRobo": "SIN REPORTE",
    "datos": {"marca": "NISSAN", "modelo": "SENTRA", "anio": "2020"}
  },
  "adeudos": {
    "tieneAdeudos": false,
    "totalAdeudos": 0
  },
  "cotizacion": {
    "verificable": true,
    "servicios": ["Verificacion vehicular sin llevar el auto"],
    "total": 500
  }
}
```

## PWA (App instalalble)

La web se puede instalar como app en Android y iOS:
- Boton "Anadir a pantalla de inicio" en Android
- En iOS: Compartir → Anadir a pantalla de inicio
- Service Worker para cache offline

## Notas importantes

1. **REPUVE funciona solo desde servidores en la nube**, no desde redes residenciales/moviles
2. **Finanzas CDMX** puede cambiar su estructura HTML sin aviso
3. Para producción considera usar la API de Apitude como respaldo (de pago pero estable)
4. La verificacion a domicilio es un servicio presencial que tu equipo realiza

## Costos estimados

- VPS basico (DigitalOcean): USD 6/mes
- Dominio .mx: USD 15/año
- WhatsApp Business API: variable por mensaje
- Apitude (opcional): por consulta

## Roadmap

- [ ] Integrar WhatsApp Business API para notificaciones automaticas
- [ ] Sistema de pagos (Stripe/MercadoPago) para cobro en linea
- [ ] Panel de administracion para gestionar consultas
- [ ] Historial de consultas por cliente
- [ ] Sistema de referidos (descuento por cada cliente referido)

## Licencia

MIT
