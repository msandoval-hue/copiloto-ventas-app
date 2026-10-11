// Casillero: archivos que el administrador deja para que los vendedores los descarguen.
// Alcance de cada archivo: todas las empresas, una empresa, una sucursal o un vendedor.
// Los archivos viven en un depósito privado de Supabase Storage; el vendedor solo recibe
// un enlace temporal (60 s) después de que el servidor comprueba que el archivo es para él.
import express from "express";
import { randomUUID } from "crypto";

const BUCKET = "casillero";
const MAX_BYTES = 25 * 1024 * 1024;
const ALCANCES = ["todas", "empresa", "sucursal", "vendedor"];
export const CATEGORIAS = ["Mercado", "Productos", "Capacitación", "Promociones", "Otros"];
const MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  mp4: "video/mp4",
};

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const extension = (n) => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
const limpiarNombre = (n) =>
  String(n)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "")
    .slice(-90) || "archivo";

// ¿El archivo es para este perfil?
export function esVisible(f, p) {
  if (!f.activo) return false;
  if (p.rol === "admin") return true;
  if (f.alcance === "todas") return true;
  if (f.alcance === "empresa") return !!p.empresa_id && f.empresa_id === p.empresa_id;
  if (f.alcance === "sucursal") return !!p.sucursal_id && f.sucursal_id === p.sucursal_id;
  if (f.alcance === "vendedor") return f.vendedor_id === p.id;
  return false;
}

export function registrarCasillero(app, { admin, auth }) {
  const soloAdmin = (req, res, next) =>
    req.perfil.rol === "admin" ? next() : res.status(403).json({ error: "Solo el administrador puede hacer esto" });
  const A = [auth, soloAdmin];
  const falla = (res, e, msg = "Error inesperado") => {
    console.error(e);
    res.status(500).json({ error: msg });
  };
  const mal = (res, msg) => res.status(400).json({ error: msg });
  const crudo = express.raw({ type: "application/octet-stream", limit: MAX_BYTES + 1024 });
  const recibir = (req, res, next) =>
    crudo(req, res, (err) => {
      if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: err.status === 413 ? "El archivo supera los 25 MB" : "No se pudo leer el archivo" });
      next();
    });

  // ===================== VENDEDOR =====================
  app.get("/api/casillero", auth, async (req, res) => {
    try {
      const p = req.perfil;
      const [{ data: fs }, { data: ds }] = await Promise.all([
        admin.from("casillero_archivos").select("id,titulo,descripcion,categoria,nombre_original,tamano,alcance,empresa_id,sucursal_id,vendedor_id,activo,created_at").eq("activo", true).order("created_at", { ascending: false }),
        admin.from("casillero_descargas").select("archivo_id").eq("vendedor_id", p.id),
      ]);
      const bajados = new Set((ds || []).map((d) => d.archivo_id));
      const lista = (fs || [])
        .filter((f) => esVisible(f, p))
        .map((f) => ({ id: f.id, titulo: f.titulo, descripcion: f.descripcion, categoria: f.categoria, nombre: f.nombre_original, tamano: f.tamano, fecha: f.created_at, nuevo: !bajados.has(f.id) }));
      res.json({ archivos: lista, nuevos: lista.filter((x) => x.nuevo).length });
    } catch (e) {
      falla(res, e, "No se pudo cargar tu casillero");
    }
  });

  app.post("/api/casillero/:id/descargar", auth, async (req, res) => {
    try {
      const p = req.perfil;
      const { data: f } = await admin.from("casillero_archivos").select("*").eq("id", req.params.id).maybeSingle();
      if (!f || !esVisible(f, p)) return res.status(404).json({ error: "Archivo no disponible" });
      const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(f.ruta, 60, { download: f.nombre_original });
      if (error || !data?.signedUrl) return falla(res, error || new Error("sin url"), "No se pudo preparar la descarga");
      if (p.rol !== "admin") {
        const { error: e2 } = await admin.from("casillero_descargas").insert({ archivo_id: f.id, vendedor_id: p.id });
        if (e2) console.error("No se pudo registrar la descarga:", e2.message);
      }
      res.json({ url: data.signedUrl, nombre: f.nombre_original });
    } catch (e) {
      falla(res, e, "No se pudo preparar la descarga");
    }
  });

  // ===================== ADMINISTRADOR =====================
  app.get("/api/admin/casillero", ...A, async (_req, res) => {
    try {
      const [f, v, d, e, s] = await Promise.all([
        admin.from("casillero_archivos").select("*").order("created_at", { ascending: false }),
        admin.from("perfiles").select("id,nombre,empresa_id,sucursal_id").eq("rol", "vendedor").eq("activo", true),
        admin.from("casillero_descargas").select("archivo_id,vendedor_id"),
        admin.from("empresas").select("id,nombre"),
        admin.from("sucursales").select("id,nombre,empresa_id"),
      ]);
      const vend = v.data || [];
      const nom = (arr, id) => (arr.data || []).find((x) => x.id === id)?.nombre || null;
      res.json(
        (f.data || []).map((x) => {
          const dest = vend.filter((u) => esVisible({ ...x, activo: true }, { ...u, rol: "vendedor" }));
          const bajaron = new Set((d.data || []).filter((y) => y.archivo_id === x.id).map((y) => y.vendedor_id));
          return {
            ...x,
            ruta: undefined,
            empresa: nom(e, x.empresa_id),
            sucursal: nom(s, x.sucursal_id),
            vendedor: vend.find((u) => u.id === x.vendedor_id)?.nombre || null,
            destinatarios: dest.length,
            descargaron: dest.filter((u) => bajaron.has(u.id)).length,
          };
        })
      );
    } catch (e) {
      falla(res, e, "No se pudo cargar el casillero");
    }
  });

  // Quién lo descargó y quién no
  app.get("/api/admin/casillero/:id/descargas", ...A, async (req, res) => {
    try {
      const { data: x } = await admin.from("casillero_archivos").select("*").eq("id", req.params.id).maybeSingle();
      if (!x) return res.status(404).json({ error: "No existe" });
      const [{ data: v }, { data: d }] = await Promise.all([
        admin.from("perfiles").select("id,nombre,empresa_id,sucursal_id").eq("rol", "vendedor").eq("activo", true),
        admin.from("casillero_descargas").select("vendedor_id,created_at").eq("archivo_id", x.id),
      ]);
      const ult = new Map();
      for (const r of d || []) if (!ult.get(r.vendedor_id) || r.created_at > ult.get(r.vendedor_id)) ult.set(r.vendedor_id, r.created_at);
      res.json(
        (v || [])
          .filter((u) => esVisible({ ...x, activo: true }, { ...u, rol: "vendedor" }))
          .map((u) => ({ id: u.id, nombre: u.nombre, descargado: ult.get(u.id) || null }))
          .sort((a, b) => Number(!!a.descargado) - Number(!!b.descargado) || a.nombre.localeCompare(b.nombre))
      );
    } catch (e) {
      falla(res, e, "No se pudo cargar el detalle");
    }
  });

  // Subida: el cuerpo es el archivo (application/octet-stream); los datos van en la URL.
  app.post("/api/admin/casillero/subir", ...A, recibir, async (req, res) => {
    let ruta = null;
    try {
      const q = req.query || {};
      const titulo = str(q.titulo, 150);
      if (!titulo) return mal(res, "El título es obligatorio");
      const nombre = str(q.nombre, 200);
      const ext = extension(nombre);
      if (!MIME[ext]) return mal(res, "Formato no permitido. Usa PDF, Word, Excel, PowerPoint, CSV, TXT, imagen o MP4.");
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || !buf.length) return mal(res, "El archivo está vacío");
      if (buf.length > MAX_BYTES) return mal(res, "El archivo supera los 25 MB");
      const alcance = str(q.alcance, 20) || "todas";
      if (!ALCANCES.includes(alcance)) return mal(res, "Alcance inválido");
      const categoria = CATEGORIAS.includes(q.categoria) ? q.categoria : "Otros";
      const fila = { titulo, descripcion: str(q.descripcion, 400) || null, categoria, nombre_original: limpiarNombre(nombre), mime: MIME[ext], tamano: buf.length, alcance, empresa_id: null, sucursal_id: null, vendedor_id: null, activo: true, created_by: req.perfil.id };
      const tabla = { empresa: ["empresas", "empresa_id"], sucursal: ["sucursales", "sucursal_id"], vendedor: ["perfiles", "vendedor_id"] }[alcance];
      if (tabla) {
        const id = str(q[tabla[1]], 60);
        if (!id) return mal(res, "Elige a quién va dirigido el archivo");
        const { data: ok } = await admin.from(tabla[0]).select("id").eq("id", id).maybeSingle();
        if (!ok) return mal(res, "El destinatario no existe");
        fila[tabla[1]] = id;
      }
      ruta = `${randomUUID()}/${fila.nombre_original}`;
      const { error: eS } = await admin.storage.from(BUCKET).upload(ruta, buf, { contentType: fila.mime, upsert: false });
      if (eS) return falla(res, eS, "No se pudo guardar el archivo");
      const { data, error } = await admin.from("casillero_archivos").insert({ ...fila, ruta }).select("id").single();
      if (error) {
        await admin.storage.from(BUCKET).remove([ruta]);
        return falla(res, error, "No se pudo registrar el archivo");
      }
      res.json({ ok: true, id: data.id });
    } catch (e) {
      if (ruta) await admin.storage.from(BUCKET).remove([ruta]).catch(() => {});
      falla(res, e, "No se pudo subir el archivo");
    }
  });

  app.patch("/api/admin/casillero/:id", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const c = {};
      if (b.titulo !== undefined) {
        c.titulo = str(b.titulo, 150);
        if (!c.titulo) return mal(res, "El título es obligatorio");
      }
      if (b.descripcion !== undefined) c.descripcion = str(b.descripcion, 400) || null;
      if (b.categoria !== undefined) c.categoria = CATEGORIAS.includes(b.categoria) ? b.categoria : "Otros";
      if (b.activo !== undefined) c.activo = !!b.activo;
      if (!Object.keys(c).length) return mal(res, "Nada que cambiar");
      const { data: x } = await admin.from("casillero_archivos").select("id").eq("id", req.params.id).maybeSingle();
      if (!x) return res.status(404).json({ error: "No existe" });
      const { error } = await admin.from("casillero_archivos").update(c).eq("id", req.params.id);
      if (error) return falla(res, error, "No se pudo guardar");
      res.json({ ok: true });
    } catch (e) {
      falla(res, e, "No se pudo guardar");
    }
  });

  app.delete("/api/admin/casillero/:id", ...A, async (req, res) => {
    try {
      const { data: x } = await admin.from("casillero_archivos").select("id,ruta").eq("id", req.params.id).maybeSingle();
      if (!x) return res.status(404).json({ error: "No existe" });
      await admin.storage.from(BUCKET).remove([x.ruta]);
      const { error } = await admin.from("casillero_archivos").delete().eq("id", x.id);
      if (error) return falla(res, error, "No se pudo eliminar");
      res.json({ ok: true });
    } catch (e) {
      falla(res, e, "No se pudo eliminar");
    }
  });
}
