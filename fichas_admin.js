// Administración de fichas técnicas: resumen de lo cargado y modelos que los asesores buscaron sin ficha.
// Solo accesible con rol "admin". Se registra desde server.js junto a las demás rutas de admin.
export function registrarFichasAdmin(app, { admin, auth, invalidarFichas }) {
  const soloAdmin = (req, res, next) =>
    req.perfil.rol === "admin" ? next() : res.status(403).json({ error: "Solo el administrador puede hacer esto" });
  const A = [auth, soloAdmin];
  const falla = (res, e, msg) => { console.error(e); res.status(500).json({ error: msg }); };

  // Qué hay cargado: por segmento, con la confianza de los datos
  app.get("/api/admin/fichas/resumen", ...A, async (_req, res) => {
    try {
      const filas = [];
      for (let d = 0; d < 5000; d += 1000) {
        const { data, error } = await admin.from("fichas_tecnicas").select("segmento,marca,confianza").range(d, d + 999);
        if (error) throw error;
        filas.push(...(data || []));
        if ((data || []).length < 1000) break;
      }
      const seg = new Map();
      for (const f of filas) {
        const s = seg.get(f.segmento) || { segmento: f.segmento, total: 0, Alta: 0, Media: 0, Baja: 0, marcas: new Set() };
        s.total++; s[f.confianza] = (s[f.confianza] || 0) + 1; s.marcas.add(f.marca);
        seg.set(f.segmento, s);
      }
      res.json({
        total: filas.length,
        segmentos: [...seg.values()].map((s) => ({ ...s, marcas: s.marcas.size })).sort((a, b) => b.total - a.total),
      });
    } catch (e) {
      falla(res, e, "No se pudo cargar el resumen de fichas (¿ejecutaste la migración 09?)");
    }
  });

  // Modelos buscados sin ficha, los más pedidos primero
  app.get("/api/admin/fichas/faltantes", ...A, async (_req, res) => {
    try {
      const [f, e] = await Promise.all([
        admin.from("fichas_faltantes").select("id,empresa_id,consulta,veces,ultima").order("veces", { ascending: false }).order("ultima", { ascending: false }).limit(200),
        admin.from("empresas").select("id,nombre"),
      ]);
      if (f.error) throw f.error;
      const nombres = new Map((e.data || []).map((x) => [x.id, x.nombre]));
      res.json((f.data || []).map((x) => ({ ...x, empresa: nombres.get(x.empresa_id) || "—" })));
    } catch (e) {
      falla(res, e, "No se pudo cargar la lista de fichas faltantes (¿ejecutaste la migración 09?)");
    }
  });

  // Quitar de la lista (cuando ya cargaste la ficha o no interesa)
  app.post("/api/admin/fichas/faltantes/quitar", ...A, async (req, res) => {
    try {
      const id = Number(req.body?.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "Falta el id" });
      const { error } = await admin.from("fichas_faltantes").delete().eq("id", id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (e) {
      falla(res, e, "No se pudo quitar");
    }
  });

  // Refrescar el catálogo en memoria después de cargar fichas nuevas (sin esperar 5 minutos)
  app.post("/api/admin/fichas/refrescar", ...A, (_req, res) => {
    try { invalidarFichas?.(); res.json({ ok: true }); } catch (e) { falla(res, e, "No se pudo refrescar"); }
  });
}
