# Copiloto de Ventas (MVP)

Chat simple para asesores comerciales: describen la situación del cliente y el copiloto
pregunta lo que falta (vehículo, score de crédito, si ya visitó) y entrega mensajes de
WhatsApp listos para copiar, con contexto Ecuador.

## Estructura

- `server.js`: Express + Claude API (con prompt caching)
- `prompts/copiloto.md`: el "cerebro" del agente (edítalo para afinar el tono)
- `public/index.html`: chat web (móvil y escritorio)

## Despliegue (GitHub + Render)

1. Sube esta carpeta a un repo de GitHub.
2. En Render: **New > Web Service**, conecta el repo.
3. Build command: `npm install` · Start command: `npm start`
4. Variables de entorno:
   - `ANTHROPIC_API_KEY` (obligatoria)
   - `APP_PIN` (recomendada: protege la app porque cada consulta cuesta)
   - `MODEL` (opcional, por defecto `claude-sonnet-5-5`)
5. Cada `git push` redespliega automáticamente.

## Prueba local

```
npm install
ANTHROPIC_API_KEY=sk-ant-... APP_PIN=1234 npm start
```
Abre http://localhost:3000

## Siguiente iteración (Kaizen)

1. Guardar consultas y feedback (👍/👎) en Supabase para medir qué mensajes funcionan.
2. Cargar portafolio, promociones vigentes y condiciones de bancos como tablas en Supabase
   y entregárselas al agente con tool use (para que no invente cifras).
3. Campo de perfil de crédito del cliente y modo "reactivar cliente > 30 días".
