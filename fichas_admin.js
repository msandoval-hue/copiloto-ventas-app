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

  // Parámetros de costo de uso (precios de combustible y energía)
  const CLAVES = ["gasolina", "super", "diesel", "kwh", "km_anio", "anios_horizonte"];
  app.get("/api/admin/costo/parametros", ...A, async (_req, res) => {
    try {
      const { data, error } = await admin.from("parametros_costo").select("clave,valor,actualizado");
      if (error) throw error;
      res.json({ parametros: Object.fromEntries((data || []).map((r) => [r.clave, { valor: r.valor === null ? null : Number(r.valor), actualizado: r.actualizado }])) });
    } catch (e) { falla(res, e, "No se pudieron cargar los parámetros (¿ejecutaste la migración 10?)"); }
  });
  app.post("/api/admin/costo/parametros", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const filas = [];
      const ahora = new Date().toISOString();
      const { data: act } = await admin.from("parametros_costo").select("clave,valor");
      const actuales = Object.fromEntries((act || []).map((r) => [r.clave, r.valor]));
      for (const k of CLAVES) {
        if (b[k] === undefined || b[k] === "") continue;
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v <= 0 || v > 1e6) return res.status(400).json({ error: `Valor inválido en ${k}` });
        filas.push({ clave: k, valor: v, actualizado: ahora });
        // La primera vez que se guarda un precio queda como precio de calibración de la curva
        if (["gasolina", "super", "diesel", "kwh"].includes(k) && (actuales[k + "_calib"] == null || b.recalibrar)) filas.push({ clave: k + "_calib", valor: v, actualizado: ahora });
      }
      if (!filas.length) return res.status(400).json({ error: "No enviaste valores" });
      if (filas.some((f) => ["gasolina", "super", "diesel", "kwh"].includes(f.clave))) filas.push({ clave: "fecha_precios", valor: 1, actualizado: ahora });
      const { error } = await admin.from("parametros_costo").upsert(filas, { onConflict: "clave" });
      if (error) throw error;
      invalidarFichas?.();
      res.json({ ok: true });
    } catch (e) { falla(res, e, "No se pudieron guardar los parámetros"); }
  });
}
