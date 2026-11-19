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

function loadEnvironmentFile() {
  const filePath = path.join(__dirname, ".env");
  if (!fs.existsSync(filePath)) return;

  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
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

async function supabaseRequest(endpoint, options = {}) {
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
    headers
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase respondeu HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function readAllRows(endpoint) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabaseRequest(endpoint, {
      headers: { Range: `${offset}-${offset + pageSize - 1}` }
    });
    if (!Array.isArray(page)) throw new Error("Supabase retornou uma lista em formato inválido.");
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function readRequestBody(request, maximumBytes = 65536) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) throw Object.assign(new Error("Corpo da requisição muito grande."), { status: 413 });
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
    readAllRows("material_progress?select=material_number,progress"),
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
  if (pathname === "/api/state" && request.method === "GET") {
    sendJson(response, 200, await getState());
    return;
  }

  if (pathname === "/api/progress" && request.method === "PATCH") {
    const body = await readRequestBody(request);
    if (!isObject(body) || typeof body.number !== "string" || !/^\d{1,20}$/.test(body.number) ||
        !isObject(body.patch) || Object.keys(body.patch).length === 0 ||
        Object.keys(body.patch).some((key) => !progressFields.has(key))) {
      throw Object.assign(new Error("Número do material ou campos de andamento inválidos."), { status: 400 });
    }
    const progress = await supabaseRequest("rpc/merge_material_progress", {
      method: "POST",
      body: JSON.stringify({ p_material_number: body.number, p_patch: body.patch })
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
    const legacyMaterials = body.legacyMaterials || [];
    if (!Array.isArray(legacyMaterials) || legacyMaterials.length > 10000) {
      throw Object.assign(new Error("Histórico legado inválido."), { status: 400 });
    }
    const validateMaterials = (items, legacy = false) => {
      const seen = new Set();
      for (const material of items) {
        if (!isObject(material) || typeof material.number !== "string" ||
            !/^\d{1,20}$/.test(material.number) || !material.number.trim() ||
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
  const pathname = new URL(request.url, "http://localhost").pathname;
  try {
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
