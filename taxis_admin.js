// Administración del segmento taxis: tipo de empresa, catálogo de homologados (importar CSV) y parámetros de operación.
import { parsearCsvTaxis, filaATabla } from "./taxis.js";

const CLAVES = ["taxi_km_dia", "taxi_dias_mes", "taxi_dias_mes_quito", "taxi_seguro_pct", "taxi_entrada_pct", "taxi_plazo_meses", "taxi_tasa_anual", "taxi_factor_autonomia_real", "taxi_mant_usd_km_ice", "taxi_ratio_mant_ice_ev", "taxi_llantas_usd_km"];

export function registrarTaxisAdmin(app, { admin, auth, invalidar }) {
  const soloAdmin = (req, res, next) =>
    req.perfil.rol === "admin" ? next() : res.status(403).json({ error: "Solo el administrador puede hacer esto" });
  const A = [auth, soloAdmin];
  const falla = (res, e, msg) => { console.error(e); res.status(500).json({ error: msg }); };

  // Resumen: empresas con su tipo, homologados cargados y parámetros
  app.get("/api/admin/taxis/resumen", ...A, async (_req, res) => {
    try {
      const [emp, hom, par] = await Promise.all([
        admin.from("empresas").select("id,nombre,tipo").order("nombre"),
        admin.from("homologacion_taxi").select("id,marca,modelo,segmento,carroceria,precio_usd,verificar,observaciones,vigente").order("marca").order("modelo"),
        admin.from("parametros_costo").select("clave,valor,nota"),
      ]);
      if (emp.error) throw emp.error;
      if (hom.error) throw hom.error;
      res.json({
        empresas: emp.data || [],
        homologados: hom.data || [],
        parametros: Object.fromEntries((par.data || []).filter((p) => p.clave.startsWith("taxi_")).map((p) => [p.clave, { valor: p.valor === null ? null : Number(p.valor), nota: p.nota }])),
      });
    } catch (e) { falla(res, e, "No se pudo cargar el módulo de taxis (¿ejecutaste la migración 11?)"); }
  });

  // Cambiar el tipo de una empresa
  app.post("/api/admin/taxis/tipo", ...A, async (req, res) => {
    try {
      const { empresa_id, tipo } = req.body || {};
      if (!["concesionario", "taxis"].includes(tipo) || !empresa_id) return res.status(400).json({ error: "Datos inválidos" });
      const { error } = await admin.from("empresas").update({ tipo }).eq("id", empresa_id);
      if (error) throw error;
      invalidar?.();
      res.json({ ok: true });
    } catch (e) { falla(res, e, "No se pudo cambiar el tipo de empresa"); }
  });

  // Importar el CSV oficial de homologados (separador ;). Valida y reporta lo que corrigió o dejó por verificar.
  app.post("/api/admin/taxis/importar", ...A, async (req, res) => {
    try {
      const texto = String(req.body?.csv || "");
      if (texto.length < 50) return res.status(400).json({ error: "El CSV está vacío" });
      const lote = String(req.body?.lote || "csv-" + new Date().toISOString().slice(0, 10)).slice(0, 40);
      const filas = parsearCsvTaxis(texto).map((r) => filaATabla(r, lote));
      if (!filas.length) return res.status(400).json({ error: "No se reconocieron filas. Revisa que el separador sea ; y que tenga las columnas Marca y Modelo." });
      const { error } = await admin.from("homologacion_taxi").upsert(filas, { onConflict: "marca,modelo" });
      if (error) throw error;
      invalidar?.();
      res.json({ ok: true, importados: filas.length, por_verificar: filas.filter((f) => f.observaciones).map((f) => `${f.marca} ${f.modelo}: ${f.observaciones}`) });
    } catch (e) { falla(res, e, "No se pudo importar el CSV"); }
  });

  // Parámetros de operación
  app.post("/api/admin/taxis/parametros", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const filas = [];
      for (const k of CLAVES) {
        if (b[k] === undefined || b[k] === "") continue;
        const v = Number(b[k]);
        if (!Number.isFinite(v) || v <= 0 || v > 1e6) return res.status(400).json({ error: `Valor inválido en ${k}` });
        filas.push({ clave: k, valor: v, actualizado: new Date().toISOString() });
      }
      if (!filas.length) return res.status(400).json({ error: "No enviaste valores" });
      const { error } = await admin.from("parametros_costo").upsert(filas, { onConflict: "clave" });
      if (error) throw error;
      invalidar?.();
      res.json({ ok: true });
    } catch (e) { falla(res, e, "No se pudieron guardar los parámetros"); }
  });
}
