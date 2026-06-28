#!/bin/bash
# ============================================
# AutoCheck MX — Script de Despliegue
# Ejecuta en tu VPS/cloud server
# ============================================

echo "🚀 Desplegando AutoCheck MX..."

# 1. Instalar dependencias
cd /ruta/a/autocheck-web
npm install --production

# 2. Configurar variables
cp .env.example .env
echo "✏️ Edita .env con tu WhatsApp y datos"

# 3. Iniciar con PM2 (para produccion)
which pm2 || npm install -g pm2
pm2 start server.js --name autocheck-mx
pm2 save
pm2 startup

echo ""
echo "✅ AutoCheck MX desplegado!"
echo "📡 Abre http://TU_IP:3000"
echo ""
echo "Para WhatsApp Business API:"
echo "  1. Ve a https://business.whatsapp.com/developers"
echo "  2. Crea un app y copia el token"
echo "  3. Pegalo en .env"
echo ""
echo "Para Nginx (opcional, dominio propio):"
echo "  sudo nano /etc/nginx/sites-available/autocheck"
echo "  proxy_pass http://localhost:3000;"
