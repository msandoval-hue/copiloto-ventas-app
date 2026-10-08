// Rutas de administración. Solo accesibles con rol "admin".
import { readFileSync } from "fs";
import { procesarCsv } from "./mercado.js";

const TZ = "America/Guayaquil";
const hoyEC = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const ROLES = ["admin", "vendedor"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
// "" o null -> null (sin valor); número entero >= 0 -> número; otra cosa -> NaN (inválido)
const entero = (v) => {
  if (v === null || v === "" || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
};

// Archivos base del repositorio que se pueden importar a la base de datos
const ARCHIVOS = [
  ["copiloto", "Cerebro del copiloto (rol, flujo y reglas)", 10],
  ["expertos", "Expertos y metodologías de venta", 20],
  ["mercado", "Datos del mercado automotriz", 30],
  ["triggers", "Triggers de persuasión", 40],
  ["practicas", "Buenas prácticas de gestión", 50],
];

export function registrarAdmin(app, { admin, auth, invalidarEmpresas, invalidarBase }) {
  const soloAdmin = (req, res, next) =>
    req.perfil.rol === "admin" ? next() : res.status(403).json({ error: "Solo el administrador puede hacer esto" });
  const A = [auth, soloAdmin];
  const falla = (res, e, msg = "Error inesperado") => {
    console.error(e);
    res.status(500).json({ error: msg });
  };
  const mal = (res, msg) => res.status(400).json({ error: msg });

  // ======================= USUARIOS =======================
  app.get("/api/admin/usuarios", ...A, async (_req, res) => {
    try {
      const [p, u, uso] = await Promise.all([
        admin.from("perfiles").select("id,rol,nombre,descripcion,telefono,empresa_id,sucursal_id,limite_diario,activo,created_at").order("nombre"),
        admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
        admin.from("uso_diario").select("vendedor_id,consultas,bloqueadas").eq("fecha", hoyEC()),
      ]);
      const emails = new Map((u.data?.users || []).map((x) => [x.id, x.email]));
      const usoMap = new Map((uso.data || []).map((x) => [x.vendedor_id, x]));
      res.json(
        (p.data || []).map((x) => ({
          ...x,
          email: emails.get(x.id) || null,
          hoy: usoMap.get(x.id)?.consultas || 0,
          bloqueadas_hoy: usoMap.get(x.id)?.bloqueadas || 0,
        }))
      );
    } catch (e) {
      falla(res, e, "No se pudo cargar los usuarios");
    }
  });

  async function validarAsignacion(b, esCreacion) {
    // devuelve {error} o {cambios}
    const c = {};
    if (b.nombre !== undefined) {
      c.nombre = str(b.nombre, 120);
      if (!c.nombre) return { error: "El nombre es obligatorio" };
    }
    if (b.rol !== undefined) {
      if (!ROLES.includes(b.rol)) return { error: "Rol inválido" };
      c.rol = b.rol;
    }
    if (b.empresa_id !== undefined) {
      c.empresa_id = b.empresa_id || null;
      if (c.empresa_id) {
        const { data } = await admin.from("empresas").select("id").eq("id", c.empresa_id).maybeSingle();
        if (!data) return { error: "La empresa no existe" };
      }
    }
    if (b.sucursal_id !== undefined) {
      c.sucursal_id = b.sucursal_id || null;
      if (c.sucursal_id) {
        const { data } = await admin.from("sucursales").select("id,empresa_id").eq("id", c.sucursal_id).maybeSingle();
        if (!data) return { error: "La sucursal no existe" };
        const emp = c.empresa_id !== undefined ? c.empresa_id : b._empresa_actual;
        if (emp && data.empresa_id !== emp) return { error: "La sucursal no pertenece a esa empresa" };
      }
    }
    if (b.limite_diario !== undefined) {
      const n = entero(b.limite_diario);
      if (Number.isNaN(n) || (n !== null && n > 100000)) return { error: "El límite diario debe ser un número entero (0 bloquea)" };
      c.limite_diario = n;
    }
    if (b.descripcion !== undefined) c.descripcion = str(b.descripcion, 1500) || null;
    if (b.telefono !== undefined) {
      const t = str(b.telefono, 25) || null;
      if (t && !/^[+\d][\d\s().-]{5,}$/.test(t)) return { error: "Teléfono inválido (usa solo números, +, espacios o guiones)" };
      c.telefono = t;
    }
    if (b.activo !== undefined) c.activo = !!b.activo;
    return { cambios: c };
  }

  app.post("/api/admin/usuarios", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const email = str(b.email, 200)?.toLowerCase();
      const password = typeof b.password === "string" ? b.password : "";
      if (!email || !EMAIL.test(email)) return mal(res, "Correo inválido");
      if (password.length < 8) return mal(res, "La clave debe tener al menos 8 caracteres");
      const v = await validarAsignacion({ rol: "vendedor", ...b, nombre: b.nombre }, true);
      if (v.error) return mal(res, v.error);
      const c = v.cambios;
      if (!c.nombre) return mal(res, "El nombre es obligatorio");
      if (c.rol === "vendedor" && !c.empresa_id) return mal(res, "Un vendedor necesita una empresa asignada");

      const { data: creado, error: e1 } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (e1 || !creado?.user) {
        const ya = /already|registered|exists/i.test(e1?.message || "");
        return mal(res, ya ? "Ese correo ya tiene un usuario" : "No se pudo crear el usuario: " + (e1?.message || ""));
      }
      const { error: e2 } = await admin.from("perfiles").insert({ id: creado.user.id, activo: true, ...c });
      if (e2) {
        await admin.auth.admin.deleteUser(creado.user.id); // deshace para no dejar un usuario sin perfil
        return falla(res, e2, "No se pudo crear el perfil");
      }
      res.json({ id: creado.user.id });
    } catch (e) {
      falla(res, e, "No se pudo crear el usuario");
    }
  });

  app.patch("/api/admin/usuarios/:id", ...A, async (req, res) => {
    try {
      const id = req.params.id;
      const b = req.body || {};
      const { data: actual } = await admin.from("perfiles").select("id,empresa_id,rol").eq("id", id).maybeSingle();
      if (!actual) return res.status(404).json({ error: "Usuario no encontrado" });
      if (id === req.perfil.id && ((b.rol !== undefined && b.rol !== "admin") || b.activo === false))
        return mal(res, "No puedes quitarte el rol de administrador ni desactivarte a ti mismo");
      const v = await validarAsignacion({ ...b, _empresa_actual: actual.empresa_id }, false);
      if (v.error) return mal(res, v.error);
      // si cambia de empresa y no se indicó sucursal, se limpia la anterior (era de otra empresa)
      if (v.cambios.empresa_id !== undefined && v.cambios.empresa_id !== actual.empresa_id && b.sucursal_id === undefined) v.cambios.sucursal_id = null;
      const rolFinal = v.cambios.rol ?? actual.rol;
      const empFinal = v.cambios.empresa_id !== undefined ? v.cambios.empresa_id : actual.empresa_id;
      if (rolFinal === "vendedor" && !empFinal) return mal(res, "Un vendedor necesita una empresa asignada");
      const cambiaClave = b.password !== undefined && b.password !== "";
      if (cambiaClave && (typeof b.password !== "string" || b.password.length < 8)) return mal(res, "La clave nueva debe tener al menos 8 caracteres");
      if (Object.keys(v.cambios).length) {
        const { error } = await admin.from("perfiles").update(v.cambios).eq("id", id);
        if (error) return falla(res, error, "No se pudo guardar");
      }
      if (cambiaClave) {
        const { error } = await admin.auth.admin.updateUserById(id, { password: b.password });
        if (error) return falla(res, error, "No se pudo cambiar la clave");
      }
      res.json({ ok: true });
    } catch (e) {
      falla(res, e, "No se pudo guardar");
    }
  });

  // ======================= EMPRESAS, SUCURSALES, MARCAS =======================
  app.get("/api/admin/empresas", ...A, async (_req, res) => {
    try {
      const [e, s, m] = await Promise.all([
        admin.from("empresas").select("id,nombre,descripcion,tono,limite_diario_default,pais,activa").order("nombre"),
        admin.from("sucursales").select("id,empresa_id,nombre,ciudad,direccion").order("nombre"),
        admin.from("marcas_empresa").select("id,empresa_id,marca").order("marca"),
      ]);
      res.json(
        (e.data || []).map((x) => ({
          ...x,
          sucursales: (s.data || []).filter((y) => y.empresa_id === x.id),
          marcas: (m.data || []).filter((y) => y.empresa_id === x.id),
        }))
      );
    } catch (e) {
      falla(res, e, "No se pudo cargar las empresas");
    }
  });

  function camposEmpresa(b) {
    const c = {};
    if (b.nombre !== undefined) {
      c.nombre = str(b.nombre, 120);
      if (!c.nombre) return { error: "El nombre de la empresa es obligatorio" };
    }
    if (b.descripcion !== undefined) c.descripcion = str(b.descripcion, 4000) || null;
    if (b.tono !== undefined) c.tono = str(b.tono, 300) || null;
    if (b.pais !== undefined) c.pais = str(b.pais, 60) || "Ecuador";
    if (b.limite_diario_default !== undefined) {
      const n = entero(b.limite_diario_default);
      if (n === null || Number.isNaN(n) || n > 100000) return { error: "El límite diario por defecto debe ser un número entero" };
      c.limite_diario_default = n;
    }
    if (b.activa !== undefined) c.activa = !!b.activa;
    return { cambios: c };
  }

  app.post("/api/admin/empresas", ...A, async (req, res) => {
    try {
      const v = camposEmpresa({ nombre: "", ...req.body });
      if (v.error) return mal(res, v.error);
      const { data, error } = await admin.from("empresas").insert(v.cambios).select("id").single();
      if (error) return falla(res, error, "No se pudo crear la empresa");
      invalidarEmpresas();
      res.json({ id: data.id });
    } catch (e) {
      falla(res, e);
    }
  });

  app.patch("/api/admin/empresas/:id", ...A, async (req, res) => {
    try {
      const v = camposEmpresa(req.body || {});
      if (v.error) return mal(res, v.error);
      const { error } = await admin.from("empresas").update(v.cambios).eq("id", req.params.id);
      if (error) return falla(res, error, "No se pudo guardar");
      invalidarEmpresas();
      res.json({ ok: true });
    } catch (e) {
      falla(res, e);
    }
  });

  app.post("/api/admin/sucursales", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const fila = { empresa_id: b.empresa_id, nombre: str(b.nombre, 120), ciudad: str(b.ciudad, 80), direccion: str(b.direccion, 200) || null };
      if (!fila.empresa_id || !fila.nombre || !fila.ciudad) return mal(res, "Empresa, nombre y ciudad son obligatorios");
      const { data, error } = await admin.from("sucursales").insert(fila).select("id").single();
      if (error) return falla(res, error, "No se pudo crear la sucursal");
      invalidarEmpresas();
      res.json({ id: data.id });
    } catch (e) {
      falla(res, e);
    }
  });

  app.delete("/api/admin/sucursales/:id", ...A, async (req, res) => {
    try {
      const { error } = await admin.from("sucursales").delete().eq("id", req.params.id);
      if (error) return falla(res, error, "No se pudo eliminar");
      invalidarEmpresas();
      res.json({ ok: true });
    } catch (e) {
      falla(res, e);
    }
  });

  app.post("/api/admin/marcas", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const fila = { empresa_id: b.empresa_id, marca: str(b.marca, 60) };
      if (!fila.empresa_id || !fila.marca) return mal(res, "Empresa y marca son obligatorias");
      const { data, error } = await admin.from("marcas_empresa").insert(fila).select("id").single();
      if (error) return mal(res, "Esa marca ya existe en la empresa");
      invalidarEmpresas();
      res.json({ id: data.id });
    } catch (e) {
      falla(res, e);
    }
  });

  app.delete("/api/admin/marcas/:id", ...A, async (req, res) => {
    try {
      const { error } = await admin.from("marcas_empresa").delete().eq("id", req.params.id);
      if (error) return falla(res, error, "No se pudo eliminar");
      invalidarEmpresas();
      res.json({ ok: true });
    } catch (e) {
      falla(res, e);
    }
  });

  // ======================= CONOCIMIENTO GLOBAL =======================
  app.get("/api/admin/conocimiento", ...A, async (_req, res) => {
    try {
      const { data, error } = await admin.from("conocimiento").select("id,clave,titulo,contenido,orden,activo,updated_at").order("orden");
      if (error) return falla(res, error, "No se pudo cargar. ¿Ejecutaste la migración 02 en Supabase?");
      res.json((data || []).map((d) => ({ ...d, largo: d.contenido.length })));
    } catch (e) {
      falla(res, e);
    }
  });

  app.put("/api/admin/conocimiento/:id", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const c = { updated_at: new Date().toISOString(), updated_by: req.perfil.id };
      if (b.titulo !== undefined) {
        c.titulo = str(b.titulo, 200);
        if (!c.titulo) return mal(res, "El título es obligatorio");
      }
      if (b.contenido !== undefined) {
        if (typeof b.contenido !== "string" || !b.contenido.trim()) return mal(res, "El contenido no puede estar vacío");
        if (b.contenido.length > 120000) return mal(res, "El contenido es demasiado largo (máx. 120.000 caracteres)");
        c.contenido = b.contenido;
      }
      if (b.orden !== undefined) {
        const n = entero(b.orden);
        if (n === null || Number.isNaN(n)) return mal(res, "El orden debe ser un número entero");
        c.orden = n;
      }
      if (b.activo !== undefined) c.activo = !!b.activo;
      const { error } = await admin.from("conocimiento").update(c).eq("id", req.params.id);
      if (error) return falla(res, error, "No se pudo guardar");
      invalidarBase();
      res.json({ ok: true });
    } catch (e) {
      falla(res, e);
    }
  });

  app.post("/api/admin/conocimiento", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const clave = str(b.clave, 60)?.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const titulo = str(b.titulo, 200);
      if (!clave || !titulo || typeof b.contenido !== "string" || !b.contenido.trim()) return mal(res, "Clave, título y contenido son obligatorios");
      const n = entero(b.orden ?? 100);
      const { data, error } = await admin
        .from("conocimiento")
        .insert({ clave, titulo, contenido: b.contenido, orden: Number.isNaN(n) || n === null ? 100 : n, updated_by: req.perfil.id })
        .select("id")
        .single();
      if (error) return mal(res, "Ya existe un documento con esa clave");
      invalidarBase();
      res.json({ id: data.id });
    } catch (e) {
      falla(res, e);
    }
  });

  app.delete("/api/admin/conocimiento/:id", ...A, async (req, res) => {
    try {
      const { error } = await admin.from("conocimiento").delete().eq("id", req.params.id);
      if (error) return falla(res, error, "No se pudo eliminar");
      invalidarBase();
      res.json({ ok: true });
    } catch (e) {
      falla(res, e);
    }
  });

  // Copia los archivos de prompts/ del repositorio a la base de datos.
  // sobrescribir=false: solo agrega los que faltan. true: restaura desde los archivos.
  app.post("/api/admin/conocimiento/importar", ...A, async (req, res) => {
    try {
      const sobrescribir = !!req.body?.sobrescribir;
      const out = { creados: [], actualizados: [], omitidos: [], faltantes: [] };
      for (const [clave, titulo, orden] of ARCHIVOS) {
        let contenido;
        try {
          contenido = readFileSync(`./prompts/${clave}.md`, "utf8");
        } catch {
          out.faltantes.push(clave);
          continue;
        }
        const { data: ex } = await admin.from("conocimiento").select("id").eq("clave", clave).maybeSingle();
        if (!ex) {
          const { error } = await admin.from("conocimiento").insert({ clave, titulo, contenido, orden, updated_by: req.perfil.id });
          if (error) return falla(res, error, "No se pudo importar " + clave);
          out.creados.push(clave);
        } else if (sobrescribir) {
          const { error } = await admin
            .from("conocimiento")
            .update({ contenido, updated_at: new Date().toISOString(), updated_by: req.perfil.id })
            .eq("id", ex.id);
          if (error) return falla(res, error, "No se pudo actualizar " + clave);
          out.actualizados.push(clave);
        } else out.omitidos.push(clave);
      }
      invalidarBase();
      res.json(out);
    } catch (e) {
      falla(res, e, "No se pudo importar. ¿Ejecutaste la migración 02 en Supabase?");
    }
  });

  // ======================= MERCADO (CSV) =======================
  // empresa_id vacío = dato general del mercado (ej. AEADE), visible para todas las empresas.
  app.get("/api/admin/mercado", ...A, async (_req, res) => {
    try {
      const filas = [];
      for (let desde = 0; desde < 200000; desde += 1000) {
        const { data, error } = await admin.from("ventas_mercado").select("empresa_id,fuente,anio,mes,ventas").range(desde, desde + 999);
        if (error) return falla(res, error, "No se pudo leer el mercado");
        filas.push(...(data || []));
        if ((data || []).length < 1000) break;
      }
      const g = new Map();
      for (const r of filas) {
        const k = `${r.empresa_id || ""}|${r.fuente}`;
        const x = g.get(k) || { empresa_id: r.empresa_id || null, fuente: r.fuente, filas: 0, unidades: 0, desde: 999999, hasta: 0 };
        const p = r.anio * 100 + r.mes;
        x.filas++; x.unidades += Number(r.ventas) || 0; x.desde = Math.min(x.desde, p); x.hasta = Math.max(x.hasta, p);
        g.set(k, x);
      }
      res.json([...g.values()]);
    } catch (e) {
      falla(res, e, "No se pudo leer el mercado");
    }
  });

  // body: { csv, empresa_id|null, fuente, simular }  -> reemplaza los meses del archivo para ese destino y fuente
  app.post("/api/admin/mercado/importar", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      const empresaId = b.empresa_id || null;
      const fuente = str(b.fuente, 60) || (empresaId ? "CSV empresa" : "CSV mercado");
      if (typeof b.csv !== "string" || !b.csv.trim()) return mal(res, "Selecciona un archivo CSV");
      let marcas = [];
      if (empresaId) {
        const { data: emp } = await admin.from("empresas").select("id").eq("id", empresaId).maybeSingle();
        if (!emp) return mal(res, "La empresa no existe");
        const { data } = await admin.from("marcas_empresa").select("marca").eq("empresa_id", empresaId);
        marcas = (data || []).map((x) => x.marca);
      } else {
        // en datos generales también marcamos como "propias" las marcas de cualquier empresa (solo informativo)
        const { data } = await admin.from("marcas_empresa").select("marca");
        marcas = [...new Set((data || []).map((x) => x.marca))];
      }
      const r = procesarCsv(b.csv, { marcasPropias: marcas });
      if (r.error) return mal(res, r.error);
      const resumen = {
        leidas: r.leidas, validas: r.filas.length, con_error: r.totalErrores, errores: r.errores,
        meses: r.periodos.length, desde: r.periodos[0] || null, hasta: r.periodos.at(-1) || null,
        unidades: r.filas.reduce((s, x) => s + x.ventas, 0), marcas: new Set(r.filas.map((x) => x.marca)).size, modelos: new Set(r.filas.map((x) => x.marca + "|" + x.modelo)).size,
      };
      if (b.simular) return res.json({ simulado: true, ...resumen });
      if (!r.filas.length) return mal(res, "Ninguna fila válida para cargar");
      if (r.totalErrores && !b.aceptar_errores) return mal(res, `Hay ${r.totalErrores} filas con error. Corrígelas o confirma cargar solo las válidas.`);

      // reemplazo por mes: borra lo anterior de ese destino+fuente en los meses presentes, luego inserta
      const meses = new Map();
      for (const x of r.filas) { if (!meses.has(x.anio)) meses.set(x.anio, new Set()); meses.get(x.anio).add(x.mes); }
      for (const [anio, ms] of meses) {
        for (const mes of ms) {
          let q = admin.from("ventas_mercado").delete().eq("anio", anio).eq("mes", mes).eq("fuente", fuente);
          q = empresaId ? q.eq("empresa_id", empresaId) : q.is("empresa_id", null);
          const { error } = await q;
          if (error) return falla(res, error, "No se pudo reemplazar los datos anteriores");
        }
      }
      const filas = r.filas.map((x) => ({ ...x, empresa_id: empresaId, fuente }));
      for (let i = 0; i < filas.length; i += 500) {
        const { error } = await admin.from("ventas_mercado").insert(filas.slice(i, i + 500));
        if (error) return falla(res, error, `Se cargaron ${i} de ${filas.length} filas y falló. Vuelve a cargar el mismo archivo: reemplaza los meses sin duplicar.`);
      }
      invalidarEmpresas();
      res.json({ ok: true, ...resumen });
    } catch (e) {
      falla(res, e, "No se pudo importar el archivo");
    }
  });

  app.post("/api/admin/mercado/borrar", ...A, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.fuente) return mal(res, "Indica la fuente a borrar");
      let q = admin.from("ventas_mercado").delete().eq("fuente", b.fuente);
      q = b.empresa_id ? q.eq("empresa_id", b.empresa_id) : q.is("empresa_id", null);
      const { error } = await q;
      if (error) return falla(res, error, "No se pudo borrar");
      invalidarEmpresas();
      res.json({ ok: true });
    } catch (e) {
      falla(res, e);
    }
  });

  // ======================= CONSULTAS: resumen y registro =======================
  app.get("/api/admin/resumen", ...A, async (req, res) => {
    try {
      const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 7, 1), 90);
      const desde = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() - (dias - 1) * 86400000));
      const [u, e] = await Promise.all([
        admin.from("resumen_consultas_usuario").select("*").gte("fecha", desde).order("fecha", { ascending: false }),
        admin.from("resumen_consultas_empresa").select("*").gte("fecha", desde).order("fecha", { ascending: false }),
      ]);
      res.json({ desde, por_usuario: u.data || [], por_empresa: e.data || [] });
    } catch (e) {
      falla(res, e, "No se pudo cargar el resumen");
    }
  });

  app.get("/api/admin/consultas", ...A, async (req, res) => {
    try {
      let q = admin
        .from("consultas_log")
        .select("id,created_at,estado,vendedor_id,empresa_id,pregunta,respuesta,util,tokens_entrada,tokens_salida")
        .order("created_at", { ascending: false })
        .limit(50);
      if (req.query.vendedor_id) q = q.eq("vendedor_id", req.query.vendedor_id);
      const [l, p] = await Promise.all([q, admin.from("perfiles").select("id,nombre")]);
      const nombres = new Map((p.data || []).map((x) => [x.id, x.nombre]));
      res.json((l.data || []).map((x) => ({ ...x, vendedor: nombres.get(x.vendedor_id) || "—" })));
    } catch (e) {
      falla(res, e, "No se pudo cargar el registro");
    }
  });
}
