#!/usr/bin/env python3
"""Crear tabla 'consultas' en Supabase via REST API"""
import json
import http.client
import sys

SUPABASE_URL = "irnzvibxkjfopapyknhc.supabase.co"

# Leer el service key desde archivo
try:
    with open("/data/data/com.termux/files/home/autocheck-web/.env.service_key", "r") as f:
        SERVICE_KEY = f.read().strip()
except FileNotFoundError:
    print("ERROR: Crea el archivo .env.service_key con el service_role key completo")
    sys.exit(1)

# SQL para crear la tabla via RPC
# Usamos el endpoint /rest/v1/rpc con una funcion personalizada
# O mejor: usar el SQL directo via la API de management de Supabase

# La tabla se crea via POST al endpoint de SQL
# Supabase no expone SQL directo via REST, necesitamos usar el dashboard
# o el CLI de supabase

# Alternativa: intentar insertar y ver si la tabla existe
conn = http.client.HTTPSConnection(SUPABASE_URL)

headers = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=minimal"
}

# Probar si la tabla existe haciendo un GET
conn.request("GET", "/rest/v1/consultas?limit=0", headers=headers)
response = conn.getresponse()
data = response.read().decode()

print(f"Status: {response.status}")
print(f"Response: {data[:500]}")

if response.status == 200:
    print("\n✅ La tabla 'consultas' YA EXISTE")
elif response.status == 404 or "does not exist" in data.lower():
    print("\n❌ La tabla 'consultas' NO EXISTE")
    print("\n--- SQL PARA CREAR LA TABLA (ejecuta en Supabase Dashboard > SQL Editor) ---")
    print("""
CREATE TABLE IF NOT EXISTS consultas (
    id BIGSERIAL PRIMARY KEY,
    folio VARCHAR(50) UNIQUE NOT NULL,
    placa VARCHAR(20) NOT NULL,
    repuve_estatus VARCHAR(50),
    repuve_datos JSONB,
    repuve_error TEXT,
    adeudos_tiene BOOLEAN DEFAULT FALSE,
    adeudos_total NUMERIC DEFAULT 0,
    adeudos_detalle JSONB,
    cotizacion_verificable BOOLEAN DEFAULT FALSE,
    cotizacion_total NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indice para busquedas por placa
CREATE INDEX IF NOT EXISTS idx_consultas_placa ON consultas(placa);
CREATE INDEX IF NOT EXISTS idx_consultas_created ON consultas(created_at DESC);

-- Habilitar RLS (Row Level Security) pero permitir todo para service_role
ALTER TABLE consultas ENABLE ROW LEVEL SECURITY;

-- Politica: service_role tiene acceso total
CREATE POLICY "Service role full access" ON consultas
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Politica: anon solo puede insertar y leer
CREATE POLICY "Anon insert" ON consultas
    FOR INSERT
    TO anon
    WITH CHECK (true);

CREATE POLICY "Anon select" ON consultas
    FOR SELECT
    TO anon
    USING (true);
""")
else:
    print(f"\n⚠️ Respuesta inesperada: {response.status}")
    print(data)
