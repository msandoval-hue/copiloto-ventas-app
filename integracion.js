// Integración con apps externas (p. ej. AppSheet de prospección): permite lanzar preguntas al copiloto
// en nombre de un asesor, con una clave de integración en lugar del login.
//   POST /api/integracion/chat   header: x-api-key: <INTEGRACION_API_KEY>
//   body: { email, pregunta, contexto?, formato? }  ->  { reply, log_id, usadas, limite }
// La pregunta cuenta en el límite diario del asesor y queda en consultas_log (y en su termómetro y resumen diario).
import { timingSafeEqual } from "node:crypto";

const TTL = 5 * 60_000;

export function crearAuthIntegracion({ admin }) {
  let cache = { t: 0, mapa: new Map() };

  async function idPorEmail(email) {
    if (Date.now() - cache.t > TTL || !cache.mapa.has(email)) {
      const mapa = new Map();
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw new Error(error.message);
        (data?.users || []).forEach((u) => u.email && mapa.set(u.email.toLowerCase(), u.id));
        if (!data?.users || data.users.length < 1000) break;
      }
      cache = { t: Date.now(), mapa };
    }
    return cache.mapa.get(email) || null;
  }

  return async function authIntegracion(req, res, next) {
    try {
      const clave = process.env.INTEGRACION_API_KEY || "";
      const dada = String(req.get("x-api-key") || "");
      const a = Buffer.from(dada), b = Buffer.from(clave);
      if (!clave || a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: "Clave de integración inválida" });

      const email = String(req.body?.email || "").trim().toLowerCase();
      const pregunta = String(req.body?.pregunta || "").trim();
      if (!email || !pregunta) return res.status(400).json({ error: "Faltan email o pregunta" });

      const id = await idPorEmail(email);
      if (!id) return res.status(404).json({ error: "No hay un usuario del copiloto con ese correo" });
      const { data: p } = await admin
        .from("perfiles")
        .select("id,rol,nombre,descripcion,telefono,empresa_id,sucursal_id,limite_diario,activo")
        .eq("id", id)
        .maybeSingle();
      if (!p || !p.activo) return res.status(403).json({ error: "Ese usuario no tiene acceso al copiloto" });

      const contexto = String(req.body?.contexto || "").trim().slice(0, 1500);
      const texto = req.body?.formato === "markdown"
        ? ""
        : "\n\n(Responde en texto plano, sin markdown ni asteriscos ni títulos, máximo 1.200 caracteres, listo para leer en un celular.)";
      req.perfil = p;
      req.body = { messages: [{ role: "user", content: (contexto ? contexto + "\n\n" : "") + pregunta.slice(0, 2000) + texto }] };
      next();
    } catch (e) {
      console.error("Integración:", e.message);
      res.status(500).json({ error: "Error de integración" });
    }
  };
}
