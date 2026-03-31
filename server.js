const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Pool } = require("pg");
const XLSX = require("xlsx");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const CATALOG_FILE = path.join(DATA_DIR, "code-part-catalog.json");
const EMPLOYEE_FILE = path.join(DATA_DIR, "employees.json");
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_COOKIE = "stockqr_session";
const sessions = new Map();
const authAccounts = {
  ADMIN: {
    username: "Admin",
    password: "1234",
    role: "admin",
    displayName: "Admin",
    appUserId: null,
    allowedViews: ["scan", "history", "dashboard", "master"]
  },
  F1: {
    username: "F1",
    password: "1234",
    role: "clerk",
    displayName: "F1",
    appUserId: null,
    allowedViews: ["scan"]
  }
};

function randomId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function parseCookies(cookieHeader) {
  return String(cookieHeader || "")
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const [key, ...rest] = part.split("=");
      acc[key] = decodeURIComponent(rest.join("=") || "");
      return acc;
    }, {});
}

function createSession(account) {
  const token = randomId();
  const session = {
    token,
    username: account.username,
    role: account.role,
    displayName: account.displayName,
    appUserId: account.appUserId,
    allowedViews: account.allowedViews.slice(),
    createdAt: new Date().toISOString()
  };
  sessions.set(token, session);
  return session;
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  return token ? sessions.get(token) || null : null;
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function toAuthPayload(session) {
  if (!session) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    user: {
      username: session.username,
      role: session.role,
      displayName: session.displayName,
      appUserId: session.appUserId,
      allowedViews: session.allowedViews.slice()
    }
  };
}

function canAccessApi(session, method, pathname) {
  if (!pathname.startsWith("/api/")) {
    return true;
  }
  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout" || pathname === "/api/auth/session") {
    return true;
  }
  if (!session) {
    return false;
  }
  if (session.role === "admin") {
    return true;
  }

  const allowed = [
    method === "GET" && pathname === "/api/bootstrap",
    method === "GET" && pathname === "/api/lookup/qr",
    method === "POST" && pathname === "/api/transactions"
  ];
  return allowed.some(Boolean);
}

function filterBootstrapBySession(data, session) {
  if (!session || session.role === "admin") {
    return {
      ...data,
      auth: toAuthPayload(session).user
    };
  }

  const visibleUsers = session.appUserId
    ? data.users.filter(item => Number(item.id) === Number(session.appUserId))
    : data.users;

  return {
    ...data,
    users: visibleUsers,
    auth: toAuthPayload(session).user
  };
}

function normalizeScanText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function upperSafe(value) {
  return String(value || "").trim().toUpperCase();
}

function extractPattern(pattern, text, fallbackIndex = 1) {
  const match = text.match(pattern);
  return match ? String(match[fallbackIndex] || "").trim() : "";
}

function parseScannedQr(rawValue) {
  const normalized = normalizeScanText(rawValue);
  if (!normalized) {
    return {
      rawValue: "",
      normalizedValue: "",
      directValue: "",
      referenceNo: "",
      partCode: "",
      workOrderNo: "",
      qty: null,
      date: "",
      process: "",
      model: ""
    };
  }

  const flattened = normalized.replace(/\n/g, " ");
  const directValue = upperSafe(normalized);
  const referenceCandidateMatch = flattened.match(/[A-Z]{1,4}\d{6,}(?:-\d{4,})+/i);
  const referenceNo = upperSafe(referenceCandidateMatch ? referenceCandidateMatch[0] : "");
  const partCode = upperSafe(referenceNo ? referenceNo.split("-")[0] : directValue);
  const workOrderNo = upperSafe(extractPattern(/\b(WO[A-Z0-9-]{4,})\b/i, flattened));
  const qtyRaw = extractPattern(/\bQTY\b\s*[:\-]?\s*(\d+(?:\.\d+)?)/i, flattened);
  const qty = qtyRaw ? Number(qtyRaw) : null;
  const date = extractPattern(/\b(20\d{2}[\/-]\d{2}[\/-]\d{2})\b/, flattened);
  const process = extractPattern(/\bProcess\b\s*[:\-]?\s*([A-Z][A-Z0-9 _/-]{1,40}?)(?=\s+\bModel\b|$)/i, flattened);
  const model = extractPattern(/\bModel\b\s*[:\-]?\s*([A-Z0-9][A-Z0-9 _/-]{0,40})/i, flattened);

  return {
    rawValue: String(rawValue || ""),
    normalizedValue: normalized,
    directValue,
    referenceNo,
    partCode,
    workOrderNo,
    qty: Number.isFinite(qty) ? qty : null,
    date,
    process,
    model
  };
}

function readPartCatalog() {
  if (!fs.existsSync(CATALOG_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(CATALOG_FILE, "utf8").replace(/^\uFEFF/, "");
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .map(item => ({
        partCode: String(item.partCode || "").trim(),
        partName: String(item.partName || "").trim(),
        machines: Array.isArray(item.machines) ? item.machines.map(value => String(value || "").trim()).filter(Boolean) : [],
        materialCodes: Array.isArray(item.materialCodes) ? item.materialCodes.map(value => String(value || "").trim()).filter(Boolean) : []
      }))
      .filter(item => item.partCode);
  } catch (error) {
    console.error("Failed to read code part catalog", error);
    return [];
  }
}

let partCatalog = readPartCatalog();

function readEmployeeSeed() {
  if (!fs.existsSync(EMPLOYEE_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(EMPLOYEE_FILE, "utf8"));
    if (!Array.isArray(data)) {
      return [];
    }

    return data
      .filter(item => item && item.employeeCode && item.fullName && item.isActive !== false)
      .map(item => ({
        employeeCode: String(item.employeeCode).trim(),
        fullName: String(item.fullName).trim(),
        isActive: item.isActive !== false
      }));
  } catch (error) {
    console.warn("Unable to read employees.json:", error.message);
    return [];
  }
}

const employeeSeed = readEmployeeSeed();
const jobSeed = [
  { id: 1, jobNo: "WIP", jobName: "WIP", customerName: "", description: "" },
  { id: 2, jobNo: "FG", jobName: "FG", customerName: "", description: "" },
  { id: 3, jobNo: "SERVICE", jobName: "SERVICE", customerName: "", description: "" }
];

function buildSeedUsers() {
  if (!employeeSeed.length) {
    return [
      { id: 1, employeeCode: "U001", fullName: "Somchai Chaiya", roleId: 1, isActive: true },
      { id: 2, employeeCode: "U008", fullName: "Wittaya Saeng", roleId: 2, isActive: true }
    ];
  }

  return employeeSeed.map((employee, index) => ({
    id: index + 1,
    employeeCode: employee.employeeCode,
    fullName: employee.fullName,
    roleId: 2,
    isActive: employee.isActive !== false
  }));
}

function syncUsersToStore(store) {
  const nextUsers = buildSeedUsers();
  const changed = JSON.stringify(store.users) !== JSON.stringify(nextUsers);
  if (changed) {
    store.users = nextUsers;
  }
  return changed;
}

function syncJobsToStore(store) {
  const changed = JSON.stringify(store.jobs) !== JSON.stringify(jobSeed);
  if (changed) {
    store.jobs = jobSeed.map(item => ({ ...item }));
  }
  return changed;
}

async function syncUsersToDatabase() {
  if (!db || !employeeSeed.length) {
    return;
  }

  for (const employee of employeeSeed) {
    await db.query(
      `INSERT INTO users (employee_code, full_name, role_id, is_active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (employee_code)
       DO UPDATE SET
         full_name = EXCLUDED.full_name,
         role_id = EXCLUDED.role_id,
         is_active = EXCLUDED.is_active,
         updated_at = CURRENT_TIMESTAMP`,
      [employee.employeeCode, employee.fullName, 2, employee.isActive !== false]
    );
  }
}

async function syncJobsToDatabase() {
  if (!db) {
    return;
  }

  for (const job of jobSeed) {
    await db.query(
      `INSERT INTO jobs (id, job_no, job_name, customer_name, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_no)
       DO UPDATE SET
         job_name = EXCLUDED.job_name,
         customer_name = EXCLUDED.customer_name,
         description = EXCLUDED.description,
         updated_at = CURRENT_TIMESTAMP`,
      [job.id, job.jobNo, job.jobName, job.customerName, job.description]
    );
  }
}

function writePartCatalog(catalog) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(catalog, null, 2));
  partCatalog = catalog;
}

function findCatalogItem(qrValue) {
  const safeValue = upperSafe(qrValue);
  if (!safeValue) {
    return null;
  }
  return partCatalog.find(item => item.partCode === safeValue) || null;
}

function resolveLookupKeys(qrValue) {
  const parsed = parseScannedQr(qrValue);
  const candidates = [parsed.directValue, parsed.referenceNo, parsed.partCode]
    .map(value => upperSafe(value))
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);

  return {
    parsed,
    candidates,
    primaryKey: candidates[0] || ""
  };
}

function findActiveQrByCandidates(qrCodes, candidates) {
  for (const candidate of candidates) {
    const qr = qrCodes.find(item => item.isActive && upperSafe(item.qrValue) === candidate);
    if (qr) {
      return qr;
    }
  }
  return null;
}
function syncCatalogToStore(store) {
  if (!partCatalog.length) {
    return false;
  }

  let changed = false;
  for (const item of partCatalog) {
    let part = store.parts.find(entry => entry.partNo === item.partCode);
    if (!part) {
      part = {
        id: nextId(store.parts),
        partNo: item.partCode,
        partName: item.partName || item.partCode,
        unit: "PCS",
        minStock: 0
      };
      store.parts.push(part);
      changed = true;
    } else if (item.partName && part.partName !== item.partName) {
      part.partName = item.partName;
      changed = true;
    }

    const existingQr = store.qrCodes.find(entry => entry.qrValue === item.partCode);
    if (!existingQr) {
      store.qrCodes.push({
        id: nextId(store.qrCodes),
        qrValue: item.partCode,
        entityType: "PART",
        entityId: part.id,
        isActive: true
      });
      changed = true;
    }
  }

  return changed;
}

async function syncCatalogToDatabase() {
  if (!db || !partCatalog.length) {
    return;
  }

  for (const item of partCatalog) {
    await ensureCatalogPartInDatabase(item);
  }
}

function buildCatalogFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("The uploaded workbook does not contain any sheets.");
  }

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: "" });
  const grouped = new Map();

  for (const row of rows) {
    const partCode = upperSafe(row["Part Code"] || row.partCode || row.PartCode || row["PART CODE"]);
    if (!partCode) {
      continue;
    }

    const entry = grouped.get(partCode) || {
      partCode,
      partName: "",
      machines: new Set(),
      materialCodes: new Set()
    };

    const partName = String(row["Part Name"] || row.partName || row.PartName || row["PART NAME"] || "").trim();
    const machine = String(row.Machine || row.machine || row["MACHINE"] || "").trim();
    const materialCode = upperSafe(row["Material Code"] || row.materialCode || row.MaterialCode || row["MATERIAL CODE"]);

    if (partName && !entry.partName) entry.partName = partName;
    if (machine) entry.machines.add(machine);
    if (materialCode) entry.materialCodes.add(materialCode);

    grouped.set(partCode, entry);
  }

  return Array.from(grouped.values())
    .map(item => ({
      partCode: item.partCode,
      partName: item.partName || item.partCode,
      machines: Array.from(item.machines),
      materialCodes: Array.from(item.materialCodes)
    }))
    .sort((a, b) => a.partCode.localeCompare(b.partCode));
}

async function ensureCatalogPartInDatabase(catalogItem) {
  if (!db || !catalogItem || !catalogItem.partCode) {
    return null;
  }

  let partResult = await db.query("SELECT id, part_no, part_name FROM parts WHERE part_no = $1", [catalogItem.partCode]);
  if (partResult.rowCount === 0) {
    partResult = await db.query(
      "INSERT INTO parts (part_no, part_name, unit, min_stock) VALUES ($1, $2, $3, $4) RETURNING id, part_no, part_name",
      [catalogItem.partCode, catalogItem.partName || catalogItem.partCode, "PCS", 0]
    );
  } else if (catalogItem.partName && partResult.rows[0].part_name !== catalogItem.partName) {
    partResult = await db.query(
      "UPDATE parts SET part_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, part_no, part_name",
      [catalogItem.partName, partResult.rows[0].id]
    );
  }

  await db.query(
    `INSERT INTO qr_codes (qr_value, entity_type, entity_id, is_active)
     VALUES ($1, 'PART', $2, TRUE)
     ON CONFLICT (qr_value) DO NOTHING`,
    [catalogItem.partCode, partResult.rows[0].id]
  );

  return {
    id: partResult.rows[0].id,
    partNo: partResult.rows[0].part_no,
    partName: partResult.rows[0].part_name
  };
}

const defaultStore = {
  roles: [
    { id: 1, roleCode: "ADMIN", roleName: "Admin" },
    { id: 2, roleCode: "CLERK", roleName: "Store Clerk" }
  ],
  users: buildSeedUsers(),
  jobs: jobSeed.map(item => ({ ...item })),
  workOrders: [],
  parts: [],
  boxes: [],
  qrCodes: [],
  statuses: [
    { id: 1, statusCode: "PENDING_RECEIVE", statusName: "Pending Receive" },
    { id: 2, statusCode: "IN_STOCK", statusName: "In Stock" },
    { id: 3, statusCode: "ISSUED", statusName: "Issued" }
  ],
  locations: [
    { id: 1, locationCode: "A01", locationName: "Rack A01" },
    { id: 2, locationCode: "PROD", locationName: "Production" }
  ],
  stockTransactions: [],
  stockBalances: []
};

const initSql = `
CREATE TABLE IF NOT EXISTS roles (
  id BIGSERIAL PRIMARY KEY,
  role_code VARCHAR(50) UNIQUE NOT NULL,
  role_name VARCHAR(100) NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  employee_code VARCHAR(50) UNIQUE NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  role_id BIGINT NOT NULL REFERENCES roles(id),
  pin_code VARCHAR(20),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  job_no VARCHAR(100) UNIQUE NOT NULL,
  job_name VARCHAR(255) NOT NULL,
  customer_name VARCHAR(255),
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS work_orders (
  id BIGSERIAL PRIMARY KEY,
  work_order_no VARCHAR(100) UNIQUE NOT NULL,
  job_id BIGINT NOT NULL REFERENCES jobs(id),
  description TEXT,
  planned_qty DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS parts (
  id BIGSERIAL PRIMARY KEY,
  part_no VARCHAR(100) UNIQUE NOT NULL,
  part_name VARCHAR(255) NOT NULL,
  unit VARCHAR(50) NOT NULL DEFAULT 'PCS',
  min_stock DECIMAL(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS boxes (
  id BIGSERIAL PRIMARY KEY,
  box_code VARCHAR(100) UNIQUE NOT NULL,
  job_id BIGINT REFERENCES jobs(id),
  work_order_id BIGINT REFERENCES work_orders(id),
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS qr_codes (
  id BIGSERIAL PRIMARY KEY,
  qr_value VARCHAR(255) UNIQUE NOT NULL,
  entity_type VARCHAR(30) NOT NULL,
  entity_id BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS locations (
  id BIGSERIAL PRIMARY KEY,
  location_code VARCHAR(50) UNIQUE NOT NULL,
  location_name VARCHAR(100) NOT NULL,
  description TEXT
);
CREATE TABLE IF NOT EXISTS item_status (
  id BIGSERIAL PRIMARY KEY,
  status_code VARCHAR(50) UNIQUE NOT NULL,
  status_name VARCHAR(100) NOT NULL
);
CREATE TABLE IF NOT EXISTS stock_transactions (
  id BIGSERIAL PRIMARY KEY,
  transaction_no VARCHAR(100) UNIQUE NOT NULL,
  qr_code_id BIGINT NOT NULL REFERENCES qr_codes(id),
  entity_type VARCHAR(30) NOT NULL,
  entity_id BIGINT NOT NULL,
  action_type VARCHAR(30) NOT NULL,
  qty DECIMAL(18,2) NOT NULL DEFAULT 0,
  from_location_id BIGINT REFERENCES locations(id),
  to_location_id BIGINT REFERENCES locations(id),
  reference_job_id BIGINT REFERENCES jobs(id),
  reference_work_order_id BIGINT REFERENCES work_orders(id),
  status_after_id BIGINT REFERENCES item_status(id),
  performed_by BIGINT NOT NULL REFERENCES users(id),
  performed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  remark TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stock_balances (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(30) NOT NULL,
  entity_id BIGINT NOT NULL,
  qty_on_hand DECIMAL(18,2) NOT NULL DEFAULT 0,
  current_status_id BIGINT REFERENCES item_status(id),
  current_location_id BIGINT REFERENCES locations(id),
  last_transaction_id BIGINT REFERENCES stock_transactions(id),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_qr_codes_qr_value ON qr_codes(qr_value);
CREATE INDEX IF NOT EXISTS idx_transactions_entity ON stock_transactions(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_transactions_performed_at ON stock_transactions(performed_at DESC);
`;

const db = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(defaultStore, null, 2));
    return;
  }

  const store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  if (syncUsersToStore(store)) {
    writeStore(store);
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function syncStoreWithCatalog() {
  const store = readStore();
  const changed = syncCatalogToStore(store) || syncUsersToStore(store) || syncJobsToStore(store);
  if (changed) {
    writeStore(store);
  }
}

function buildLookupResponse({ found, qrValue, matchedQrValue = "", entityType = "", entityCode = "", entityName = "", catalogItem = null, parsed = null }) {
  return {
    found,
    qrValue: String(qrValue || "").trim(),
    matchedQrValue: matchedQrValue || entityCode || "",
    entityType,
    entityCode,
    entityName,
    machines: catalogItem ? catalogItem.machines : [],
    materialCodes: catalogItem ? catalogItem.materialCodes : [],
    parsed: parsed ? {
      referenceNo: parsed.referenceNo || "",
      partCode: parsed.partCode || "",
      workOrderNo: parsed.workOrderNo || "",
      qty: parsed.qty ?? null,
      date: parsed.date || "",
      process: parsed.process || "",
      model: parsed.model || ""
    } : null
  };
}

async function importCatalog(payload) {
  const contentBase64 = String(payload.contentBase64 || "");
  if (!contentBase64) {
    throw new Error("No file content was uploaded.");
  }

  const buffer = Buffer.from(contentBase64, "base64");
  const catalog = buildCatalogFromWorkbook(buffer);
  if (!catalog.length) {
    throw new Error("No usable rows were found in the uploaded file.");
  }

  writePartCatalog(catalog);

  if (!db) {
    syncStoreWithCatalog();
  } else {
    await syncCatalogToDatabase();
  }

  return {
    message: "Catalog imported successfully.",
    totalParts: catalog.length
  };
}

function json(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  };

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function nextId(items) {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}

function resolveEntity(store, entityType, entityId) {
  const maps = {
    JOB: ["jobs", "jobNo", "jobName"],
    WORK_ORDER: ["workOrders", "workOrderNo", "description"],
    PART: ["parts", "partNo", "partName"],
    BOX: ["boxes", "boxCode", "description"]
  };
  const config = maps[entityType];
  if (!config) {
    return null;
  }
  const [collection, codeKey, nameKey] = config;
  const entity = store[collection].find(item => item.id === entityId);
  if (!entity) {
    return null;
  }
  return { code: entity[codeKey], name: entity[nameKey] || entity[codeKey] };
}

function normalizeWorkOrderCode(value) {
  return upperSafe(value);
}

function resolveSubmittedWorkOrderCode(payload) {
  return normalizeWorkOrderCode(payload.workOrderCode || payload.workOrderNo || "");
}

function ensureWorkOrderInStore(store, workOrderCode, jobId) {
  const normalizedCode = normalizeWorkOrderCode(workOrderCode);
  if (!normalizedCode) {
    return null;
  }

  let workOrder = store.workOrders.find(item => normalizeWorkOrderCode(item.workOrderNo) === normalizedCode);
  if (workOrder) {
    return workOrder;
  }

  const fallbackJobId = Number(jobId) || store.jobs[0]?.id || null;
  if (!fallbackJobId) {
    return null;
  }

  workOrder = {
    id: nextId(store.workOrders),
    workOrderNo: normalizedCode,
    description: "",
    jobId: fallbackJobId,
    plannedQty: 0
  };
  store.workOrders.push(workOrder);
  return workOrder;
}

async function ensureWorkOrderInDatabase(client, workOrderCode, jobId) {
  const normalizedCode = normalizeWorkOrderCode(workOrderCode);
  if (!normalizedCode) {
    return null;
  }

  const existing = await client.query(
    "SELECT id, work_order_no, description, job_id, planned_qty FROM work_orders WHERE UPPER(work_order_no) = $1 LIMIT 1",
    [normalizedCode]
  );
  if (existing.rowCount > 0) {
    return existing.rows[0];
  }

  const resolvedJobId = Number(jobId) || jobSeed[0]?.id || null;
  if (!resolvedJobId) {
    return null;
  }

  const inserted = await client.query(
    `INSERT INTO work_orders (work_order_no, description, job_id, planned_qty)
     VALUES ($1, $2, $3, $4)
     RETURNING id, work_order_no, description, job_id, planned_qty`,
    [normalizedCode, "", resolvedJobId, 0]
  );
  return inserted.rows[0];
}

function enrichTransaction(store, transaction) {
  const qr = store.qrCodes.find(item => item.id === transaction.qrCodeId);
  const user = store.users.find(item => item.id === transaction.performedBy);
  const status = store.statuses.find(item => item.id === transaction.statusAfterId);
  const toLocation = store.locations.find(item => item.id === transaction.toLocationId);
  const entity = resolveEntity(store, transaction.entityType, transaction.entityId);
  const job = transaction.referenceJobId ? store.jobs.find(item => item.id === transaction.referenceJobId) : null;
  const workOrder = transaction.referenceWorkOrderId ? store.workOrders.find(item => item.id === transaction.referenceWorkOrderId) : null;

  return {
    ...transaction,
    qrValue: qr ? qr.qrValue : "-",
    entityCode: entity ? entity.code : "-",
    entityName: entity ? entity.name : "-",
    userName: user ? user.fullName : "-",
    statusAfterName: status ? status.statusName : "-",
    toLocationName: toLocation ? toLocation.locationName : "-",
    jobNo: job ? job.jobNo : "",
    workOrderNo: workOrder ? workOrder.workOrderNo : ""
  };
}

function computeDashboard(store) {
  return store.stockBalances.map(balance => {
    const entity = resolveEntity(store, balance.entityType, balance.entityId);
    const status = store.statuses.find(item => item.id === balance.currentStatusId);
    const location = store.locations.find(item => item.id === balance.currentLocationId);
    const part = balance.entityType === "PART" ? store.parts.find(item => item.id === balance.entityId) : null;

    return {
      id: balance.id,
      entityType: balance.entityType,
      entityId: balance.entityId,
      code: entity ? entity.code : "-",
      name: entity ? entity.name : "-",
      qtyOnHand: Number(balance.qtyOnHand),
      currentStatus: status ? status.statusName : "-",
      currentLocation: location ? location.locationName : "-",
      updatedAt: balance.updatedAt,
      unit: part ? part.unit : "",
      minStock: part ? Number(part.minStock) : 0,
      isLowStock: part ? Number(balance.qtyOnHand) <= Number(part.minStock) : false
    };
  });
}

function handleCreateTransactionFile(store, payload) {
  const { parsed, candidates } = resolveLookupKeys(payload.qrValue);
  const workOrderCode = resolveSubmittedWorkOrderCode(payload);
  let qr = findActiveQrByCandidates(store.qrCodes, candidates);
  if (!qr) {
    const catalogItem = candidates.map(findCatalogItem).find(Boolean);
    if (catalogItem) {
      syncCatalogToStore(store);
      qr = findActiveQrByCandidates(store.qrCodes, candidates);
    }
  }
  if (!qr) {
    return { statusCode: 400, payload: { error: "QR code not found." } };
  }

  const user = store.users.find(item => item.id === Number(payload.userId) && item.isActive);
  if (!user) {
    return { statusCode: 400, payload: { error: "User not found." } };
  }

  const qty = Number(payload.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { statusCode: 400, payload: { error: "Quantity must be greater than zero." } };
  }

  const actionType = String(payload.actionType || "").toUpperCase();
  if (!["RECEIVE", "ISSUE"].includes(actionType)) {
    return { statusCode: 400, payload: { error: "Action must be RECEIVE or ISSUE." } };
  }

  const statusCode = actionType === "RECEIVE" ? "IN_STOCK" : "ISSUED";
  const status = store.statuses.find(item => item.statusCode === statusCode);
  const locationCode = String(payload.toLocationCode || (actionType === "RECEIVE" ? "A01" : "PROD")).toUpperCase();
  let location = store.locations.find(item => item.locationCode === locationCode);
  if (!location) {
    location = { id: nextId(store.locations), locationCode, locationName: locationCode };
    store.locations.push(location);
  }

  let balance = store.stockBalances.find(item => item.entityType === qr.entityType && item.entityId === qr.entityId);
  const currentQty = balance ? Number(balance.qtyOnHand) : 0;
  if (actionType === "ISSUE" && currentQty < qty) {
    return { statusCode: 400, payload: { error: `Not enough stock. Current balance is ${currentQty}.` } };
  }

  const workOrder = ensureWorkOrderInStore(store, workOrderCode, payload.jobId);

  const transactionId = nextId(store.stockTransactions);
  const transaction = {
    id: transactionId,
    transactionNo: `TXN-${String(transactionId).padStart(5, "0")}`,
    qrCodeId: qr.id,
    entityType: qr.entityType,
    entityId: qr.entityId,
    actionType,
    qty,
    fromLocationId: actionType === "ISSUE" && balance ? balance.currentLocationId : null,
    toLocationId: location.id,
    referenceJobId: payload.jobId ? Number(payload.jobId) : null,
    referenceWorkOrderId: workOrder ? workOrder.id : null,
    statusAfterId: status ? status.id : null,
    performedBy: user.id,
    performedAt: new Date().toISOString(),
    remark: [String(payload.remark || "").trim(), parsed.referenceNo && parsed.referenceNo !== upperSafe(qr.qrValue) ? `Ref No: ${parsed.referenceNo}` : ""]
      .filter(Boolean)
      .join(" | ")
  };

  store.stockTransactions.push(transaction);
  const newQty = actionType === "RECEIVE" ? currentQty + qty : currentQty - qty;

  if (balance) {
    balance.qtyOnHand = newQty;
    balance.currentStatusId = transaction.statusAfterId;
    balance.currentLocationId = location.id;
    balance.lastTransactionId = transaction.id;
    balance.updatedAt = transaction.performedAt;
  } else {
    balance = {
      id: nextId(store.stockBalances),
      entityType: qr.entityType,
      entityId: qr.entityId,
      qtyOnHand: newQty,
      currentStatusId: transaction.statusAfterId,
      currentLocationId: location.id,
      lastTransactionId: transaction.id,
      updatedAt: transaction.performedAt
    };
    store.stockBalances.push(balance);
  }

  writeStore(store);
  return {
    statusCode: 201,
    payload: {
      message: "Transaction saved.",
      transaction: enrichTransaction(store, transaction),
      balance
    }
  };
}

function toCamelUser(row) {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    roleId: row.role_id,
    isActive: row.is_active
  };
}

function toCamelJob(row) {
  return {
    id: row.id,
    jobNo: row.job_no,
    jobName: row.job_name,
    customerName: row.customer_name,
    description: row.description
  };
}

function toCamelWorkOrder(row) {
  return {
    id: row.id,
    workOrderNo: row.work_order_no,
    jobId: row.job_id,
    description: row.description,
    plannedQty: Number(row.planned_qty)
  };
}

function toCamelLocation(row) {
  return {
    id: row.id,
    locationCode: row.location_code,
    locationName: row.location_name
  };
}

async function initializeDatabase() {
  if (!db) {
    ensureStore();
    syncStoreWithCatalog();
    return;
  }

  await db.query(initSql);
  const countResult = await db.query("SELECT COUNT(*)::int AS count FROM roles");
  if (countResult.rows[0].count > 0) {
    try {
      await syncJobsToDatabase();
    } catch (error) {
      console.error("Job sync skipped during startup", error);
    }
    try {
      await syncUsersToDatabase();
    } catch (error) {
      console.error("Employee sync skipped during startup", error);
    }
    try {
      await syncCatalogToDatabase();
    } catch (error) {
      console.error("Catalog sync skipped during startup", error);
    }
    return;
  }

  await db.query("BEGIN");
  try {
    await db.query("INSERT INTO roles (id, role_code, role_name) VALUES (1, 'ADMIN', 'Admin'), (2, 'CLERK', 'Store Clerk')");
    await db.query("INSERT INTO jobs (id, job_no, job_name, customer_name, description) VALUES (1, 'WIP', 'WIP', '', ''), (2, 'FG', 'FG', '', ''), (3, 'SERVICE', 'SERVICE', '', '')");
    if (!employeeSeed.length) {
      await db.query("INSERT INTO users (id, employee_code, full_name, role_id, is_active) VALUES (1, 'U001', 'Somchai Chaiya', 1, TRUE), (2, 'U008', 'Wittaya Saeng', 2, TRUE)");
    }
    await db.query("INSERT INTO item_status (id, status_code, status_name) VALUES (1, 'PENDING_RECEIVE', 'Pending Receive'), (2, 'IN_STOCK', 'In Stock'), (3, 'ISSUED', 'Issued')");
    await db.query("INSERT INTO locations (id, location_code, location_name) VALUES (1, 'A01', 'Rack A01'), (2, 'PROD', 'Production')");
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }

  try {
    await syncJobsToDatabase();
  } catch (error) {
    console.error("Job sync skipped during startup", error);
  }

  try {
    await syncUsersToDatabase();
  } catch (error) {
    console.error("Employee sync skipped during startup", error);
  }

  try {
    await syncCatalogToDatabase();
  } catch (error) {
    console.error("Catalog sync skipped during startup", error);
  }
}

async function getBootstrapData() {
  if (!db) {
    const store = readStore();
    return {
      users: store.users,
      jobs: store.jobs,
      workOrders: store.workOrders,
      locations: store.locations,
      qrCodes: store.qrCodes
    };
  }

  const [users, jobs, workOrders, locations, qrCodes] = await Promise.all([
    db.query("SELECT id, employee_code, full_name, role_id, is_active FROM users WHERE is_active = TRUE ORDER BY id"),
    db.query("SELECT id, job_no, job_name, customer_name, description FROM jobs ORDER BY id"),
    db.query("SELECT id, work_order_no, job_id, description, planned_qty FROM work_orders ORDER BY id"),
    db.query("SELECT id, location_code, location_name FROM locations ORDER BY id"),
    db.query("SELECT id, qr_value, entity_type, entity_id, is_active FROM qr_codes WHERE is_active = TRUE ORDER BY id")
  ]);

  const allowedEmployeeCodes = new Set(employeeSeed.map(item => item.employeeCode));
  const mappedUsers = users.rows.map(toCamelUser);
  const bootstrapUsers = allowedEmployeeCodes.size
    ? mappedUsers.filter(item => allowedEmployeeCodes.has(item.employeeCode))
    : mappedUsers;
  const allowedJobNos = new Set(jobSeed.map(item => item.jobNo));
  const bootstrapJobs = jobs.rows
    .map(toCamelJob)
    .filter(item => allowedJobNos.has(item.jobNo));

  return {
    users: bootstrapUsers,
    jobs: bootstrapJobs,
    workOrders: workOrders.rows.map(toCamelWorkOrder),
    locations: locations.rows.map(toCamelLocation),
    qrCodes: qrCodes.rows.map(row => ({
      id: row.id,
      qrValue: row.qr_value,
      entityType: row.entity_type,
      entityId: row.entity_id,
      isActive: row.is_active
    }))
  };
}

function authenticateCredentials(username, password) {
  const account = authAccounts[upperSafe(username)];
  if (!account || String(password || "") !== account.password) {
    return null;
  }
  return account;
}

async function getTransactions(filters) {
  if (!db) {
    const store = readStore();
    let rows = store.stockTransactions.map(item => enrichTransaction(store, item));
    const fromTime = filters.from ? new Date(filters.from) : null;
    const toTime = filters.to ? new Date(filters.to) : null;
    if (filters.q) {
      const needle = filters.q.toLowerCase();
      rows = rows.filter(item =>
        [item.qrValue, item.entityCode, item.entityName, item.userName, item.jobNo, item.workOrderNo]
          .filter(Boolean)
          .some(value => value.toLowerCase().includes(needle))
      );
    }
    if (filters.action) {
      rows = rows.filter(item => item.actionType === filters.action.toUpperCase());
    }
    if (fromTime && !Number.isNaN(fromTime.getTime())) {
      rows = rows.filter(item => new Date(item.performedAt) >= fromTime);
    }
    if (toTime && !Number.isNaN(toTime.getTime())) {
      rows = rows.filter(item => new Date(item.performedAt) <= toTime);
    }
    rows.sort((a, b) => new Date(b.performedAt) - new Date(a.performedAt));
    return rows;
  }

  const params = [];
  const conditions = [];
  if (filters.action) {
    params.push(filters.action.toUpperCase());
    conditions.push(`t.action_type = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    conditions.push(`(
      LOWER(q.qr_value) LIKE $${params.length}
      OR LOWER(COALESCE(p.part_no, b.box_code, j.job_no, wo2.work_order_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(p.part_name, b.description, j.job_name, wo2.description, '')) LIKE $${params.length}
      OR LOWER(u.full_name) LIKE $${params.length}
      OR LOWER(COALESCE(j2.job_no, '')) LIKE $${params.length}
      OR LOWER(COALESCE(wo.work_order_no, '')) LIKE $${params.length}
    )`);
  }
  if (filters.from) {
    const fromTime = new Date(filters.from);
    if (!Number.isNaN(fromTime.getTime())) {
      params.push(fromTime.toISOString());
      conditions.push(`t.performed_at >= $${params.length}`);
    }
  }
  if (filters.to) {
    const toTime = new Date(filters.to);
    if (!Number.isNaN(toTime.getTime())) {
      params.push(toTime.toISOString());
      conditions.push(`t.performed_at <= $${params.length}`);
    }
  }

  const query = `
    SELECT
      t.id, t.transaction_no, t.qr_code_id, t.entity_type, t.entity_id, t.action_type, t.qty,
      t.from_location_id, t.to_location_id, t.reference_job_id, t.reference_work_order_id,
      t.status_after_id, t.performed_by, t.performed_at, t.remark,
      q.qr_value, u.full_name AS user_name, s.status_name AS status_after_name,
      l.location_name AS to_location_name, j2.job_no, wo.work_order_no,
      COALESCE(p.part_no, b.box_code, j.job_no, wo2.work_order_no) AS entity_code,
      COALESCE(p.part_name, b.description, j.job_name, wo2.description, wo2.work_order_no) AS entity_name
    FROM stock_transactions t
    JOIN qr_codes q ON q.id = t.qr_code_id
    JOIN users u ON u.id = t.performed_by
    LEFT JOIN item_status s ON s.id = t.status_after_id
    LEFT JOIN locations l ON l.id = t.to_location_id
    LEFT JOIN jobs j2 ON j2.id = t.reference_job_id
    LEFT JOIN work_orders wo ON wo.id = t.reference_work_order_id
    LEFT JOIN parts p ON t.entity_type = 'PART' AND p.id = t.entity_id
    LEFT JOIN boxes b ON t.entity_type = 'BOX' AND b.id = t.entity_id
    LEFT JOIN jobs j ON t.entity_type = 'JOB' AND j.id = t.entity_id
    LEFT JOIN work_orders wo2 ON t.entity_type = 'WORK_ORDER' AND wo2.id = t.entity_id
    ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
    ORDER BY t.performed_at DESC
  `;

  const result = await db.query(query, params);
  return result.rows.map(row => ({
    id: row.id,
    transactionNo: row.transaction_no,
    qrCodeId: row.qr_code_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actionType: row.action_type,
    qty: Number(row.qty),
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    referenceJobId: row.reference_job_id,
    referenceWorkOrderId: row.reference_work_order_id,
    statusAfterId: row.status_after_id,
    performedBy: row.performed_by,
    performedAt: row.performed_at,
    remark: row.remark,
    qrValue: row.qr_value,
    entityCode: row.entity_code || "-",
    entityName: row.entity_name || "-",
    userName: row.user_name || "-",
    statusAfterName: row.status_after_name || "-",
    toLocationName: row.to_location_name || "-",
    jobNo: row.job_no || "",
    workOrderNo: row.work_order_no || ""
  }));
}

async function getTransactionByNumber(transactionNo) {
  if (!transactionNo) {
    return null;
  }

  if (!db) {
    const store = readStore();
    const transaction = store.stockTransactions.find(item => item.transactionNo === transactionNo);
    return transaction ? enrichTransaction(store, transaction) : null;
  }

  const result = await db.query(
    `SELECT
       t.id, t.transaction_no, t.qr_code_id, t.entity_type, t.entity_id, t.action_type, t.qty,
       t.from_location_id, t.to_location_id, t.reference_job_id, t.reference_work_order_id,
       t.status_after_id, t.performed_by, t.performed_at, t.remark,
       q.qr_value, u.full_name AS user_name, s.status_name AS status_after_name,
       l.location_name AS to_location_name, j2.job_no, wo.work_order_no,
       COALESCE(p.part_no, b.box_code, j.job_no, wo2.work_order_no) AS entity_code,
       COALESCE(p.part_name, b.description, j.job_name, wo2.description, wo2.work_order_no) AS entity_name
     FROM stock_transactions t
     JOIN qr_codes q ON q.id = t.qr_code_id
     JOIN users u ON u.id = t.performed_by
     LEFT JOIN item_status s ON s.id = t.status_after_id
     LEFT JOIN locations l ON l.id = t.to_location_id
     LEFT JOIN jobs j2 ON j2.id = t.reference_job_id
     LEFT JOIN work_orders wo ON wo.id = t.reference_work_order_id
     LEFT JOIN parts p ON t.entity_type = 'PART' AND p.id = t.entity_id
     LEFT JOIN boxes b ON t.entity_type = 'BOX' AND b.id = t.entity_id
     LEFT JOIN jobs j ON t.entity_type = 'JOB' AND j.id = t.entity_id
     LEFT JOIN work_orders wo2 ON t.entity_type = 'WORK_ORDER' AND wo2.id = t.entity_id
     WHERE t.transaction_no = $1
     LIMIT 1`,
    [transactionNo]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    transactionNo: row.transaction_no,
    qrCodeId: row.qr_code_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actionType: row.action_type,
    qty: Number(row.qty),
    fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id,
    referenceJobId: row.reference_job_id,
    referenceWorkOrderId: row.reference_work_order_id,
    statusAfterId: row.status_after_id,
    performedBy: row.performed_by,
    performedAt: row.performed_at,
    remark: row.remark,
    qrValue: row.qr_value,
    entityCode: row.entity_code || "-",
    entityName: row.entity_name || "-",
    userName: row.user_name || "-",
    statusAfterName: row.status_after_name || "-",
    toLocationName: row.to_location_name || "-",
    jobNo: row.job_no || "",
    workOrderNo: row.work_order_no || ""
  };
}

async function getDashboard() {
  const filters = arguments[0] || {};
  const fromTime = filters.from ? new Date(filters.from) : null;
  const toTime = filters.to ? new Date(filters.to) : null;
  const inRange = value => {
    if (!value) return false;
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return false;
    if (fromTime && time < fromTime) return false;
    if (toTime && time > toTime) return false;
    return true;
  };

  if (!db) {
    const store = readStore();
    let balances = computeDashboard(store);
    let recentTransactions = store.stockTransactions
      .slice()
      .sort((a, b) => new Date(b.performedAt) - new Date(a.performedAt))
      .map(item => enrichTransaction(store, item));

    if (fromTime || toTime) {
      balances = balances.filter(item => inRange(item.updatedAt));
      recentTransactions = recentTransactions.filter(item => inRange(item.performedAt));
    }

    return {
      balances,
      recentTransactions: recentTransactions.slice(0, 5)
    };
  }

  const balanceParams = [];
  const balanceConditions = [];
  if (fromTime) {
    balanceParams.push(fromTime.toISOString());
    balanceConditions.push(`sb.updated_at >= $${balanceParams.length}`);
  }
  if (toTime) {
    balanceParams.push(toTime.toISOString());
    balanceConditions.push(`sb.updated_at <= $${balanceParams.length}`);
  }

  const balancesResult = await db.query(`
    SELECT
      sb.id, sb.entity_type, sb.entity_id, sb.qty_on_hand, sb.updated_at,
      s.status_name AS current_status, l.location_name AS current_location,
      p.unit, p.min_stock,
      COALESCE(p.part_no, b.box_code, j.job_no, wo.work_order_no) AS code,
      COALESCE(p.part_name, b.description, j.job_name, wo.description, wo.work_order_no) AS name
    FROM stock_balances sb
    LEFT JOIN item_status s ON s.id = sb.current_status_id
    LEFT JOIN locations l ON l.id = sb.current_location_id
    LEFT JOIN parts p ON sb.entity_type = 'PART' AND p.id = sb.entity_id
    LEFT JOIN boxes b ON sb.entity_type = 'BOX' AND b.id = sb.entity_id
    LEFT JOIN jobs j ON sb.entity_type = 'JOB' AND j.id = sb.entity_id
    LEFT JOIN work_orders wo ON sb.entity_type = 'WORK_ORDER' AND wo.id = sb.entity_id
    ${balanceConditions.length ? `WHERE ${balanceConditions.join(" AND ")}` : ""}
    ORDER BY code ASC
  `, balanceParams);

  const transactionFilters = {};
  if (filters.from) transactionFilters.from = filters.from;
  if (filters.to) transactionFilters.to = filters.to;
  const recentTransactions = await getTransactions(transactionFilters);
  return {
    balances: balancesResult.rows.map(row => ({
      id: row.id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      code: row.code || "-",
      name: row.name || "-",
      qtyOnHand: Number(row.qty_on_hand),
      currentStatus: row.current_status || "-",
      currentLocation: row.current_location || "-",
      updatedAt: row.updated_at,
      unit: row.unit || "",
      minStock: Number(row.min_stock || 0),
      isLowStock: row.entity_type === "PART" ? Number(row.qty_on_hand) <= Number(row.min_stock || 0) : false
    })),
    recentTransactions: recentTransactions.slice(0, 5)
  };
}

async function createTransaction(payload) {
  if (!db) {
    return handleCreateTransactionFile(readStore(), payload);
  }

  const actionType = String(payload.actionType || "").toUpperCase();
  const qty = Number(payload.qty);
  const workOrderCode = resolveSubmittedWorkOrderCode(payload);
  if (!["RECEIVE", "ISSUE"].includes(actionType)) {
    return { statusCode: 400, payload: { error: "Action must be RECEIVE or ISSUE." } };
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return { statusCode: 400, payload: { error: "Quantity must be greater than zero." } };
  }

  const { parsed, candidates } = resolveLookupKeys(payload.qrValue);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    let qrResult = { rowCount: 0, rows: [] };
    if (candidates.length) {
      qrResult = await client.query(
        `SELECT id, qr_value, entity_type, entity_id
         FROM qr_codes
         WHERE UPPER(qr_value) = ANY($1::text[]) AND is_active = TRUE
         ORDER BY array_position($1::text[], UPPER(qr_value)), id
         LIMIT 1`,
        [candidates]
      );
    }
    if (qrResult.rowCount === 0) {
      const catalogItem = candidates.map(findCatalogItem).find(Boolean);
      if (catalogItem) {
        await ensureCatalogPartInDatabase(catalogItem);
        qrResult = await client.query(
          `SELECT id, qr_value, entity_type, entity_id
           FROM qr_codes
           WHERE UPPER(qr_value) = ANY($1::text[]) AND is_active = TRUE
           ORDER BY array_position($1::text[], UPPER(qr_value)), id
           LIMIT 1`,
          [candidates]
        );
      }
    }
    if (qrResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { statusCode: 400, payload: { error: "QR code not found." } };
    }
    const qr = qrResult.rows[0];

    const userResult = await client.query("SELECT id FROM users WHERE id = $1 AND is_active = TRUE", [Number(payload.userId)]);
    if (userResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return { statusCode: 400, payload: { error: "User not found." } };
    }

    const statusCode = actionType === "RECEIVE" ? "IN_STOCK" : "ISSUED";
    const statusResult = await client.query("SELECT id FROM item_status WHERE status_code = $1", [statusCode]);
    const status = statusResult.rows[0];

    const locationCode = String(payload.toLocationCode || (actionType === "RECEIVE" ? "A01" : "PROD")).toUpperCase();
    const locationResult = await client.query(
      `INSERT INTO locations (location_code, location_name)
       VALUES ($1, $2)
       ON CONFLICT (location_code)
       DO UPDATE SET location_name = EXCLUDED.location_name
       RETURNING id`,
      [locationCode, locationCode]
    );
    const location = locationResult.rows[0];
    const workOrder = await ensureWorkOrderInDatabase(client, workOrderCode, payload.jobId);

    const balanceResult = await client.query(
      `SELECT id, qty_on_hand, current_location_id
       FROM stock_balances
       WHERE entity_type = $1 AND entity_id = $2
       FOR UPDATE`,
      [qr.entity_type, qr.entity_id]
    );
    const currentBalance = balanceResult.rows[0];
    const currentQty = currentBalance ? Number(currentBalance.qty_on_hand) : 0;
    if (actionType === "ISSUE" && currentQty < qty) {
      await client.query("ROLLBACK");
      return { statusCode: 400, payload: { error: `Not enough stock. Current balance is ${currentQty}.` } };
    }

    const nextIdResult = await client.query("SELECT nextval(pg_get_serial_sequence('stock_transactions', 'id')) AS next_id");
    const transactionId = Number(nextIdResult.rows[0].next_id);
    const transactionNo = `TXN-${String(transactionId).padStart(5, "0")}`;
    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO stock_transactions
       (id, transaction_no, qr_code_id, entity_type, entity_id, action_type, qty, from_location_id, to_location_id, reference_job_id, reference_work_order_id, status_after_id, performed_by, performed_at, remark)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        transactionId,
        transactionNo,
        qr.id,
        qr.entity_type,
        qr.entity_id,
        actionType,
        qty,
        actionType === "ISSUE" && currentBalance ? currentBalance.current_location_id : null,
        location.id,
        payload.jobId ? Number(payload.jobId) : null,
        workOrder ? Number(workOrder.id) : null,
        status ? status.id : null,
        Number(payload.userId),
        now,
        [String(payload.remark || "").trim(), parsed.referenceNo && parsed.referenceNo !== upperSafe(qr.qr_value) ? `Ref No: ${parsed.referenceNo}` : ""]
          .filter(Boolean)
          .join(" | ")
      ]
    );

    const newQty = actionType === "RECEIVE" ? currentQty + qty : currentQty - qty;
    await client.query(
      `INSERT INTO stock_balances
       (entity_type, entity_id, qty_on_hand, current_status_id, current_location_id, last_transaction_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET
         qty_on_hand = EXCLUDED.qty_on_hand,
         current_status_id = EXCLUDED.current_status_id,
         current_location_id = EXCLUDED.current_location_id,
         last_transaction_id = EXCLUDED.last_transaction_id,
         updated_at = EXCLUDED.updated_at`,
      [qr.entity_type, qr.entity_id, newQty, status ? status.id : null, location.id, transactionId, now]
    );

    await client.query("COMMIT");
    const transaction = await getTransactionByNumber(transactionNo);
    return {
      statusCode: 201,
      payload: {
        message: "Transaction saved.",
        transaction,
        balance: {
          entityType: qr.entity_type,
          entityId: qr.entity_id,
          qtyOnHand: newQty,
          currentStatusId: status ? status.id : null,
          currentLocationId: location.id,
          lastTransactionId: transactionId,
          updatedAt: now
        }
      }
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getQrLookup(qrValue) {
  const safeValue = String(qrValue || "").trim();
  const { parsed, candidates } = resolveLookupKeys(qrValue);
  if (!safeValue) {
    return buildLookupResponse({ found: false, qrValue: safeValue, parsed });
  }

  const catalogItem = candidates.map(findCatalogItem).find(Boolean) || null;

  if (!db) {
    const store = readStore();
    const qr = findActiveQrByCandidates(store.qrCodes, candidates);
    if (!qr) {
      if (catalogItem) {
        return buildLookupResponse({
          found: true,
          qrValue: safeValue,
          matchedQrValue: catalogItem.partCode,
          entityType: "PART",
          entityCode: catalogItem.partCode,
          entityName: catalogItem.partName || catalogItem.partCode,
          catalogItem,
          parsed
        });
      }
      return buildLookupResponse({ found: false, qrValue: safeValue, parsed });
    }

    const entity = resolveEntity(store, qr.entityType, qr.entityId);
    return buildLookupResponse({
      found: true,
      qrValue: safeValue,
      matchedQrValue: qr.qrValue,
      entityType: qr.entityType,
      entityCode: entity ? entity.code : qr.qrValue,
      entityName: entity ? entity.name : (catalogItem ? catalogItem.partName : qr.qrValue),
      catalogItem,
      parsed
    });
  }

  const result = candidates.length ? await db.query(
    `SELECT
       q.qr_value,
       q.entity_type,
       COALESCE(p.part_no, b.box_code, j.job_no, wo.work_order_no) AS entity_code,
       COALESCE(p.part_name, b.description, j.job_name, wo.description, wo.work_order_no) AS entity_name
     FROM qr_codes q
     LEFT JOIN parts p ON q.entity_type = 'PART' AND p.id = q.entity_id
     LEFT JOIN boxes b ON q.entity_type = 'BOX' AND b.id = q.entity_id
     LEFT JOIN jobs j ON q.entity_type = 'JOB' AND j.id = q.entity_id
     LEFT JOIN work_orders wo ON q.entity_type = 'WORK_ORDER' AND wo.id = q.entity_id
     WHERE UPPER(q.qr_value) = ANY($1::text[]) AND q.is_active = TRUE
     ORDER BY array_position($1::text[], UPPER(q.qr_value)), q.id
     LIMIT 1`,
    [candidates]
  ) : { rowCount: 0, rows: [] };

  if (result.rowCount === 0 && catalogItem) {
    return buildLookupResponse({
      found: true,
      qrValue: safeValue,
      matchedQrValue: catalogItem.partCode,
      entityType: "PART",
      entityCode: catalogItem.partCode,
      entityName: catalogItem.partName || catalogItem.partCode,
      catalogItem,
      parsed
    });
  }

  if (result.rowCount === 0) {
    return buildLookupResponse({ found: false, qrValue: safeValue, parsed });
  }

  const row = result.rows[0];
  return buildLookupResponse({
    found: true,
    qrValue: safeValue,
    matchedQrValue: row.qr_value,
    entityType: row.entity_type,
    entityCode: row.entity_code || row.qr_value,
    entityName: row.entity_name || (catalogItem ? catalogItem.partName : row.qr_value),
    catalogItem,
    parsed
  });
}

function parseMasterEntity(entity) {
  const map = {
    parts: "parts",
    boxes: "boxes",
    jobs: "jobs",
    "work-orders": "workOrders",
    qrs: "qrCodes"
  };
  return map[entity] || null;
}

function csvEscape(value) {
  const safe = value === null || value === undefined ? "" : String(value);
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvResponse(res, filename, rows) {
  const content = rows.map(row => row.map(csvEscape).join(",")).join("\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(content);
}

function xlsxResponse(res, filename, sheetName, rows) {
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(buffer);
}

function normalizeMasterRow(entity, row) {
  if (entity === "parts") {
    return {
      id: row.id,
      code: row.part_no ?? row.partNo,
      name: row.part_name ?? row.partName,
      extra1: row.unit,
      extra2: Number(row.min_stock ?? row.minStock ?? 0)
    };
  }
  if (entity === "boxes") {
    return {
      id: row.id,
      code: row.box_code ?? row.boxCode,
      name: row.description ?? "",
      extra1: row.job_id ?? row.jobId ?? "",
      extra2: row.work_order_id ?? row.workOrderId ?? ""
    };
  }
  if (entity === "jobs") {
    return {
      id: row.id,
      code: row.job_no ?? row.jobNo,
      name: row.job_name ?? row.jobName,
      extra1: row.customer_name ?? row.customerName ?? "",
      extra2: row.description ?? ""
    };
  }
  if (entity === "work-orders") {
    return {
      id: row.id,
      code: row.work_order_no ?? row.workOrderNo,
      name: row.description ?? "",
      extra1: row.job_id ?? row.jobId ?? "",
      extra2: Number(row.planned_qty ?? row.plannedQty ?? 0)
    };
  }
  return {
    id: row.id,
    code: row.qr_value ?? row.qrValue,
    name: row.entity_type ?? row.entityType,
    extra1: row.entity_id ?? row.entityId,
    extra2: row.is_active ?? row.isActive
  };
}

async function getMasterData(entity) {
  if (!db) {
    const store = readStore();
    const key = parseMasterEntity(entity);
    return store[key].map(item => normalizeMasterRow(entity, item));
  }

  const queries = {
    parts: "SELECT id, part_no, part_name, unit, min_stock FROM parts ORDER BY id DESC",
    boxes: "SELECT id, box_code, description, job_id, work_order_id FROM boxes ORDER BY id DESC",
    jobs: "SELECT id, job_no, job_name, customer_name, description FROM jobs ORDER BY id DESC",
    "work-orders": "SELECT id, work_order_no, description, job_id, planned_qty FROM work_orders ORDER BY id DESC",
    qrs: "SELECT id, qr_value, entity_type, entity_id, is_active FROM qr_codes ORDER BY id DESC"
  };

  const result = await db.query(queries[entity]);
  return result.rows.map(row => normalizeMasterRow(entity, row));
}

async function createMasterData(entity, payload) {
  if (!db) {
    const store = readStore();
    const key = parseMasterEntity(entity);
    const id = nextId(store[key]);
    let created;

    if (entity === "parts") {
      created = { id, partNo: payload.code, partName: payload.name, unit: payload.extra1 || "PCS", minStock: Number(payload.extra2 || 0) };
    } else if (entity === "boxes") {
      created = { id, boxCode: payload.code, description: payload.name || "", jobId: payload.extra1 ? Number(payload.extra1) : null, workOrderId: payload.extra2 ? Number(payload.extra2) : null };
    } else if (entity === "jobs") {
      created = { id, jobNo: payload.code, jobName: payload.name, customerName: payload.extra1 || "", description: payload.extra2 || "" };
    } else if (entity === "work-orders") {
      created = { id, workOrderNo: payload.code, description: payload.name || "", jobId: Number(payload.extra1), plannedQty: Number(payload.extra2 || 0) };
    } else {
      created = { id, qrValue: payload.code, entityType: payload.name, entityId: Number(payload.extra1), isActive: payload.extra2 !== false };
    }

    store[key].push(created);
    writeStore(store);
    return normalizeMasterRow(entity, created);
  }

  let result;
  if (entity === "parts") {
    result = await db.query(
      "INSERT INTO parts (part_no, part_name, unit, min_stock) VALUES ($1, $2, $3, $4) RETURNING id, part_no, part_name, unit, min_stock",
      [payload.code, payload.name, payload.extra1 || "PCS", Number(payload.extra2 || 0)]
    );
  } else if (entity === "boxes") {
    result = await db.query(
      "INSERT INTO boxes (box_code, description, job_id, work_order_id) VALUES ($1, $2, $3, $4) RETURNING id, box_code, description, job_id, work_order_id",
      [payload.code, payload.name || "", payload.extra1 ? Number(payload.extra1) : null, payload.extra2 ? Number(payload.extra2) : null]
    );
  } else if (entity === "jobs") {
    result = await db.query(
      "INSERT INTO jobs (job_no, job_name, customer_name, description) VALUES ($1, $2, $3, $4) RETURNING id, job_no, job_name, customer_name, description",
      [payload.code, payload.name, payload.extra1 || "", payload.extra2 || ""]
    );
  } else if (entity === "work-orders") {
    result = await db.query(
      "INSERT INTO work_orders (work_order_no, description, job_id, planned_qty) VALUES ($1, $2, $3, $4) RETURNING id, work_order_no, description, job_id, planned_qty",
      [payload.code, payload.name || "", Number(payload.extra1), Number(payload.extra2 || 0)]
    );
  } else {
    result = await db.query(
      "INSERT INTO qr_codes (qr_value, entity_type, entity_id, is_active) VALUES ($1, $2, $3, $4) RETURNING id, qr_value, entity_type, entity_id, is_active",
      [payload.code, String(payload.name || "").toUpperCase(), Number(payload.extra1), payload.extra2 !== false]
    );
  }

  return normalizeMasterRow(entity, result.rows[0]);
}

async function updateMasterData(entity, id, payload) {
  const numericId = Number(id);
  if (!db) {
    const store = readStore();
    const key = parseMasterEntity(entity);
    const index = store[key].findIndex(item => item.id === numericId);
    if (index === -1) {
      throw new Error("Master data not found.");
    }

    if (entity === "parts") {
      store[key][index] = {
        ...store[key][index],
        partNo: payload.code,
        partName: payload.name,
        unit: payload.extra1 || "PCS",
        minStock: Number(payload.extra2 || 0)
      };
    } else if (entity === "boxes") {
      store[key][index] = {
        ...store[key][index],
        boxCode: payload.code,
        description: payload.name || "",
        jobId: payload.extra1 ? Number(payload.extra1) : null,
        workOrderId: payload.extra2 ? Number(payload.extra2) : null
      };
    } else if (entity === "jobs") {
      store[key][index] = {
        ...store[key][index],
        jobNo: payload.code,
        jobName: payload.name,
        customerName: payload.extra1 || "",
        description: payload.extra2 || ""
      };
    } else if (entity === "work-orders") {
      store[key][index] = {
        ...store[key][index],
        workOrderNo: payload.code,
        description: payload.name || "",
        jobId: Number(payload.extra1),
        plannedQty: Number(payload.extra2 || 0)
      };
    } else {
      store[key][index] = {
        ...store[key][index],
        qrValue: payload.code,
        entityType: String(payload.name || "").toUpperCase(),
        entityId: Number(payload.extra1),
        isActive: payload.extra2 !== "false"
      };
    }

    writeStore(store);
    return normalizeMasterRow(entity, store[key][index]);
  }

  let result;
  if (entity === "parts") {
    result = await db.query(
      "UPDATE parts SET part_no = $1, part_name = $2, unit = $3, min_stock = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING id, part_no, part_name, unit, min_stock",
      [payload.code, payload.name, payload.extra1 || "PCS", Number(payload.extra2 || 0), numericId]
    );
  } else if (entity === "boxes") {
    result = await db.query(
      "UPDATE boxes SET box_code = $1, description = $2, job_id = $3, work_order_id = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING id, box_code, description, job_id, work_order_id",
      [payload.code, payload.name || "", payload.extra1 ? Number(payload.extra1) : null, payload.extra2 ? Number(payload.extra2) : null, numericId]
    );
  } else if (entity === "jobs") {
    result = await db.query(
      "UPDATE jobs SET job_no = $1, job_name = $2, customer_name = $3, description = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING id, job_no, job_name, customer_name, description",
      [payload.code, payload.name, payload.extra1 || "", payload.extra2 || "", numericId]
    );
  } else if (entity === "work-orders") {
    result = await db.query(
      "UPDATE work_orders SET work_order_no = $1, description = $2, job_id = $3, planned_qty = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING id, work_order_no, description, job_id, planned_qty",
      [payload.code, payload.name || "", Number(payload.extra1), Number(payload.extra2 || 0), numericId]
    );
  } else {
    result = await db.query(
      "UPDATE qr_codes SET qr_value = $1, entity_type = $2, entity_id = $3, is_active = $4 WHERE id = $5 RETURNING id, qr_value, entity_type, entity_id, is_active",
      [payload.code, String(payload.name || "").toUpperCase(), Number(payload.extra1), payload.extra2 !== "false", numericId]
    );
  }

  if (result.rowCount === 0) {
    throw new Error("Master data not found.");
  }
  return normalizeMasterRow(entity, result.rows[0]);
}

async function deleteMasterData(entity, id) {
  const numericId = Number(id);
  if (!db) {
    const store = readStore();
    const key = parseMasterEntity(entity);
    const index = store[key].findIndex(item => item.id === numericId);
    if (index === -1) {
      throw new Error("Master data not found.");
    }
    store[key].splice(index, 1);
    writeStore(store);
    return { success: true };
  }

  const tables = {
    parts: "parts",
    boxes: "boxes",
    jobs: "jobs",
    "work-orders": "work_orders",
    qrs: "qr_codes"
  };
  const result = await db.query(`DELETE FROM ${tables[entity]} WHERE id = $1 RETURNING id`, [numericId]);
  if (result.rowCount === 0) {
    throw new Error("Master data not found.");
  }
  return { success: true };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const session = getSessionFromRequest(req);

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    json(res, 200, { ok: true, storage: db ? "postgres" : "file" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/auth/session") {
    json(res, 200, toAuthPayload(session));
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/auth/login") {
    try {
      const body = await parseBody(req);
      const account = authenticateCredentials(body.username, body.password);
      if (!account) {
        json(res, 401, { error: "Invalid username or password." });
        return;
      }
      const nextSession = createSession(account);
      json(res, 200, toAuthPayload(nextSession), { "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(nextSession.token)}; Path=/; HttpOnly; SameSite=Lax` });
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      sessions.delete(token);
    }
    json(res, 200, { success: true }, { "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    return;
  }

  if (!canAccessApi(session, req.method, requestUrl.pathname)) {
    const statusCode = session ? 403 : 401;
    json(res, statusCode, { error: statusCode === 401 ? "Please log in first." : "You do not have access to this page." });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
    try {
      json(res, 200, filterBootstrapBySession(await getBootstrapData(), session));
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/transactions") {
    try {
      const q = requestUrl.searchParams.get("q");
      const action = requestUrl.searchParams.get("action");
      json(res, 200, await getTransactions({ q, action }));
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/lookup/qr") {
    try {
      json(res, 200, await getQrLookup(requestUrl.searchParams.get("value")));
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/transactions") {
    try {
      const body = await parseBody(req);
      if (session?.role === "clerk" && session?.appUserId) {
        body.userId = session.appUserId;
      }
      const result = await createTransaction(body);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/dashboard") {
    try {
      const from = requestUrl.searchParams.get("from");
      const to = requestUrl.searchParams.get("to");
      json(res, 200, await getDashboard({ from, to }));
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/master/import/catalog") {
    try {
      const body = await parseBody(req);
      json(res, 200, await importCatalog(body));
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/api/master/")) {
    try {
      const entity = requestUrl.pathname.replace("/api/master/", "");
      if (!parseMasterEntity(entity)) {
        json(res, 404, { error: "Master entity not found." });
        return;
      }
      json(res, 200, await getMasterData(entity));
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname.startsWith("/api/master/")) {
    try {
      const entity = requestUrl.pathname.replace("/api/master/", "");
      if (!parseMasterEntity(entity)) {
        json(res, 404, { error: "Master entity not found." });
        return;
      }
      const body = await parseBody(req);
      const created = await createMasterData(entity, body);
      json(res, 201, created);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if ((req.method === "PUT" || req.method === "DELETE") && requestUrl.pathname.startsWith("/api/master/")) {
    try {
      const parts = requestUrl.pathname.split("/").filter(Boolean);
      const entity = parts[2];
      const id = parts[3];
      if (!parseMasterEntity(entity) || !id) {
        json(res, 404, { error: "Master entity not found." });
        return;
      }

      if (req.method === "PUT") {
        const body = await parseBody(req);
        json(res, 200, await updateMasterData(entity, id, body));
      } else {
        json(res, 200, await deleteMasterData(entity, id));
      }
    } catch (error) {
      const message = error.code === "23503"
        ? "ลบข้อมูลนี้ไม่ได้ เพราะยังมีข้อมูลอื่นอ้างอิงอยู่"
        : (error.message || "Unexpected server error.");
      json(res, 500, { error: message });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/export/transactions.csv") {
    try {
      const rows = await getTransactions({});
      csvResponse(res, "transactions.csv", [
        ["Transaction No", "QR", "Entity Type", "Entity Code", "Entity Name", "Action", "Qty", "Status", "User", "Job", "Work Order", "Location", "Performed At", "Remark"],
        ...rows.map(item => [
          item.transactionNo, item.qrValue, item.entityType, item.entityCode, item.entityName, item.actionType,
          item.qty, item.statusAfterName, item.userName, item.jobNo, item.workOrderNo, item.toLocationName, item.performedAt, item.remark || ""
        ])
      ]);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/export/balances.csv") {
    try {
      const data = await getDashboard();
      csvResponse(res, "balances.csv", [
        ["Entity Type", "Code", "Name", "Qty On Hand", "Unit", "Status", "Location", "Updated At", "Low Stock"],
        ...data.balances.map(item => [
          item.entityType, item.code, item.name, item.qtyOnHand, item.unit, item.currentStatus, item.currentLocation, item.updatedAt, item.isLowStock ? "YES" : "NO"
        ])
      ]);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/export/transactions.xlsx") {
    try {
      const rows = await getTransactions({});
      xlsxResponse(res, "transactions.xlsx", "Transactions", [
        ["Transaction No", "QR", "Entity Type", "Entity Code", "Entity Name", "Action", "Qty", "Status", "User", "Job", "Work Order", "Location", "Performed At", "Remark"],
        ...rows.map(item => [
          item.transactionNo, item.qrValue, item.entityType, item.entityCode, item.entityName, item.actionType,
          item.qty, item.statusAfterName, item.userName, item.jobNo, item.workOrderNo, item.toLocationName, item.performedAt, item.remark || ""
        ])
      ]);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/export/balances.xlsx") {
    try {
      const data = await getDashboard();
      xlsxResponse(res, "balances.xlsx", "Balances", [
        ["Entity Type", "Code", "Name", "Qty On Hand", "Unit", "Status", "Location", "Updated At", "Low Stock"],
        ...data.balances.map(item => [
          item.entityType, item.code, item.name, item.qtyOnHand, item.unit, item.currentStatus, item.currentLocation, item.updatedAt, item.isLowStock ? "YES" : "NO"
        ])
      ]);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  const publicPath = requestUrl.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, requestUrl.pathname);
  if (publicPath.startsWith(PUBLIC_DIR)) {
    sendFile(res, publicPath);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

initializeDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Stock QR MVP is running at http://localhost:${PORT} (${db ? "postgres" : "file"})`);
    });
  })
  .catch(error => {
    console.error("Failed to initialize storage", error);
    process.exit(1);
  });
