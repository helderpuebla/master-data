const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");

const siteDirectory = path.join(__dirname, "site");
const publicFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]]
]);
const progressFields = new Set([
  "configDone", "configDoneAt", "qCaseNumber", "qaApproved", "qaDecisionAt",
  "acknowledge", "acknowledgedAt", "rejectedCases", "workflow", "item8"
]);
const materialNumberPattern = /^(?:7|8|68274|1001)\d*$/;

function isMaterialNumber(value) {
  return typeof value === "string" && value.length <= 20 && materialNumberPattern.test(value);
}

function loadEnvironmentFile() {
  const filePath = path.join(__dirname, ".env");
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvironmentFile();
const port = Number(process.env.PORT || 8000);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function getSupabaseConfig() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo .env.");
  }
  if (supabaseUrl.includes("YOUR_PROJECT") || serviceRoleKey === "replace_with_service_role_key") {
    throw new Error("Substitua os valores de exemplo do Supabase no arquivo .env.");
  }
  const parsedUrl = new URL(supabaseUrl);
  if (parsedUrl.protocol !== "https:") {
    throw new Error("SUPABASE_URL deve usar HTTPS para proteger a chave do servidor.");
  }
  return { supabaseUrl: `${parsedUrl.origin}/`, serviceRoleKey };
}

async function supabaseRequest(endpoint, { withCount = false, ...options } = {}) {
  const { supabaseUrl, serviceRoleKey } = getSupabaseConfig();
  const headers = {
    apikey: serviceRoleKey,
    "Content-Type": "application/json",
    "User-Agent": "master-data-backend/1.0",
    ...options.headers
  };
  if (!serviceRoleKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${serviceRoleKey}`;
  }
  const response = await fetch(new URL(`rest/v1/${endpoint}`, supabaseUrl), {
    ...options,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) {
    let code;
    try {
      code = JSON.parse(text)?.code;
    } catch {
      // Upstream gateways can return errors in formats other than JSON.
    }
    if (endpoint === "rpc/sync_materials" && code === "PT409") {
      throw Object.assign(new Error("Uma extração mais recente já está salva."), { status: 409 });
    }
    if (endpoint === "rpc/try_save_material_progress" && code === "PT409") {
      throw Object.assign(new Error("O andamento mudou em outra sessão. Os dados serão atualizados."), { status: 409 });
    }
    if (endpoint.endsWith("material_progress") && code === "23503") {
      throw Object.assign(new Error("Material não encontrado no histórico."), { status: 404 });
    }
    throw new Error(`Supabase respondeu HTTP ${response.status}.`);
  }
  const data = text ? JSON.parse(text) : null;
  if (!withCount) return data;
  const match = response.headers.get("content-range")?.match(/\/(\d+)$/);
  if (!match) throw new Error("Supabase não informou o total de registros.");
  return { data, total: Number(match[1]) };
}

async function readAllRows(endpoint) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; ) {
    const page = await supabaseRequest(endpoint, {
      headers: { Prefer: "count=exact", Range: `${offset}-${offset + pageSize - 1}` },
      withCount: true
    });
    if (!Array.isArray(page.data)) throw new Error("Supabase retornou uma lista em formato inválido.");
    rows.push(...page.data);
    offset += page.data.length;
    if (!page.data.length || offset >= page.total) return rows;
  }
}

async function readRequestBody(request, maximumBytes = 65536) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maximumBytes) {
      request.resume();
      throw Object.assign(new Error("Corpo da requisição muito grande."), { status: 413 });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("O corpo da requisição não contém JSON válido."), { status: 400 });
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function getState() {
  const [rows, progressRows, metadata] = await Promise.all([
    readAllRows("material_data?select=material_number,description,status,is_new,first_seen_at,last_seen_at&order=first_seen_at.asc,material_number.asc"),
    readAllRows("material_progress?select=material_number,progress&order=material_number.asc"),
    supabaseRequest("sync_metadata?select=generated_at&id=eq.true")
  ]);
  const records = {};
  for (const row of progressRows) records[row.material_number] = row.progress;
  return {
    generatedAt: metadata[0]?.generated_at || new Date(0).toISOString(),
    materials: rows.map((row) => ({
      number: row.material_number,
      description: row.description,
      status: row.status,
      isNew: row.is_new,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at
    })),
    records
  };
}

function verifySyncToken(request) {
  const expected = process.env.MASTER_DATA_SYNC_TOKEN || "";
  const provided = request.headers["x-sync-token"] || "";
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length >= 32 && expected !== "generate_a_long_random_secret" &&
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes);
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { application: "master-data" });
    return;
  }

  if (pathname === "/api/state" && request.method === "GET") {
    sendJson(response, 200, await getState());
    return;
  }

  if (pathname === "/api/progress" && request.method === "PATCH") {
    const body = await readRequestBody(request);
    if (!isObject(body) || !isMaterialNumber(body.number) ||
        !isObject(body.patch) || Object.keys(body.patch).length === 0 ||
        Object.keys(body.patch).some((key) => !progressFields.has(key)) ||
        (Object.hasOwn(body, "expected") && body.expected !== null && !isObject(body.expected)) ||
        (Object.hasOwn(body, "importOnly") && body.importOnly !== true)) {
      throw Object.assign(new Error("Número do material ou campos de andamento inválidos."), { status: 400 });
    }
    if (!Object.hasOwn(body, "expected") && body.importOnly !== true) {
      sendJson(response, 428, { error: "Recarregue a página antes de salvar para verificar a versão do andamento." });
      return;
    }
    const progress = await supabaseRequest("rpc/try_save_material_progress", {
      method: "POST",
      body: JSON.stringify({
        p_material_number: body.number,
        p_patch: body.patch,
        p_expected: body.expected ?? null,
        p_import_only: body.importOnly === true
      })
    });
    sendJson(response, 200, { number: body.number, progress });
    return;
  }

  if (pathname === "/api/sync" && request.method === "POST") {
    if (!verifySyncToken(request)) {
      sendJson(response, 401, { error: "Token de sincronização inválido." });
      return;
    }
    const body = await readRequestBody(request, 1048576);
    if (!isObject(body) || typeof body.generatedAt !== "string" ||
        Number.isNaN(Date.parse(body.generatedAt)) || !Array.isArray(body.materials) ||
        body.materials.length > 1000) {
      throw Object.assign(new Error("Formato da extração inválido."), { status: 400 });
    }
    const legacyMaterials = Object.hasOwn(body, "legacyMaterials") ? body.legacyMaterials : [];
    if (!Array.isArray(legacyMaterials) || legacyMaterials.length > 10000) {
      throw Object.assign(new Error("Histórico legado inválido."), { status: 400 });
    }
    const validateMaterials = (items, legacy = false) => {
      const seen = new Set();
      for (const material of items) {
        if (!isObject(material) || !isMaterialNumber(material.number) ||
            (!legacy && (!/^[78]/.test(material.number) || material.status !== "NEW")) ||
            typeof material.description !== "string" || typeof material.status !== "string" ||
            seen.has(material.number)) {
          throw Object.assign(new Error("A extração contém material inválido ou duplicado."), { status: 400 });
        }
        if (legacy &&
            (typeof material.firstSeenAt !== "string" || Number.isNaN(Date.parse(material.firstSeenAt)) ||
             typeof material.lastSeenAt !== "string" || Number.isNaN(Date.parse(material.lastSeenAt)))) {
          throw Object.assign(new Error("O histórico legado contém datas inválidas."), { status: 400 });
        }
        seen.add(material.number);
      }
    };
    validateMaterials(body.materials);
    validateMaterials(legacyMaterials, true);
    await supabaseRequest("rpc/sync_materials", {
      method: "POST",
      body: JSON.stringify({
        p_materials: body.materials,
        p_generated_at: body.generatedAt,
        p_legacy_materials: legacyMaterials
      })
    });
    sendJson(response, 200, { message: `Sincronização concluída: ${body.materials.length} materiais.` });
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Endpoint não encontrado." });
    return;
  }
  sendJson(response, 405, { error: "Método não permitido." });
}

http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  try {
    let pathname;
    try {
      pathname = new URL(request.url, "http://localhost").pathname;
    } catch {
      sendJson(response, 400, { error: "Endereço da requisição inválido." });
      return;
    }
    if (pathname.startsWith("/api/")) {
      await handleApi(request, response, pathname);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const publicFile = publicFiles.get(pathname);
    if (!publicFile) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    const [fileName, contentType] = publicFile;
    fs.readFile(path.join(siteDirectory, fileName), (error, content) => {
      if (error) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unable to read the requested site file.");
        return;
      }
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : content);
    });
  } catch (error) {
    sendJson(response, error.status || 500, { error: error.message });
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`Master Data site listening on port ${port}.`);
  console.log(`This computer: http://localhost:${port}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`Network: http://${address.address}:${port}`);
      }
    }
  }
});
