const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

const defaultStore = {
  roles: [
    { id: 1, roleCode: "ADMIN", roleName: "Admin" },
    { id: 2, roleCode: "CLERK", roleName: "Store Clerk" }
  ],
  users: [
    { id: 1, employeeCode: "U001", fullName: "Somchai Chaiya", roleId: 1, isActive: true },
    { id: 2, employeeCode: "U008", fullName: "Wittaya Saeng", roleId: 2, isActive: true }
  ],
  jobs: [
    { id: 1, jobNo: "JOB-20260325-01", jobName: "Motor Housing", customerName: "ACME", description: "Pilot lot" }
  ],
  workOrders: [
    { id: 1, workOrderNo: "WO-20260325-01", jobId: 1, description: "Line A", plannedQty: 120 }
  ],
  parts: [
    { id: 1, partNo: "PT-1002", partName: "Bearing", unit: "PCS", minStock: 10 },
    { id: 2, partNo: "PT-2004", partName: "Housing", unit: "PCS", minStock: 5 }
  ],
  boxes: [
    { id: 1, boxCode: "BX-00045", jobId: 1, workOrderId: 1, description: "Bearing set box" }
  ],
  qrCodes: [
    { id: 1, qrValue: "JOB-20260325-01", entityType: "JOB", entityId: 1, isActive: true },
    { id: 2, qrValue: "WO-20260325-01", entityType: "WORK_ORDER", entityId: 1, isActive: true },
    { id: 3, qrValue: "PT-1002", entityType: "PART", entityId: 1, isActive: true },
    { id: 4, qrValue: "PT-2004", entityType: "PART", entityId: 2, isActive: true },
    { id: 5, qrValue: "BX-00045", entityType: "BOX", entityId: 1, isActive: true }
  ],
  statuses: [
    { id: 1, statusCode: "PENDING_RECEIVE", statusName: "Pending Receive" },
    { id: 2, statusCode: "IN_STOCK", statusName: "In Stock" },
    { id: 3, statusCode: "ISSUED", statusName: "Issued" }
  ],
  locations: [
    { id: 1, locationCode: "A01", locationName: "Rack A01" },
    { id: 2, locationCode: "PROD", locationName: "Production" }
  ],
  stockTransactions: [
    {
      id: 1,
      transactionNo: "TXN-00001",
      qrCodeId: 3,
      entityType: "PART",
      entityId: 1,
      actionType: "RECEIVE",
      qty: 50,
      fromLocationId: null,
      toLocationId: 1,
      referenceJobId: 1,
      referenceWorkOrderId: 1,
      statusAfterId: 2,
      performedBy: 1,
      performedAt: "2026-03-25T09:15:00.000Z",
      remark: "Initial receive"
    },
    {
      id: 2,
      transactionNo: "TXN-00002",
      qrCodeId: 3,
      entityType: "PART",
      entityId: 1,
      actionType: "ISSUE",
      qty: 5,
      fromLocationId: 1,
      toLocationId: 2,
      referenceJobId: 1,
      referenceWorkOrderId: 1,
      statusAfterId: 3,
      performedBy: 2,
      performedAt: "2026-03-25T14:42:00.000Z",
      remark: "Issue to line"
    }
  ],
  stockBalances: [
    {
      id: 1,
      entityType: "PART",
      entityId: 1,
      qtyOnHand: 45,
      currentStatusId: 3,
      currentLocationId: 2,
      lastTransactionId: 2,
      updatedAt: "2026-03-25T14:42:00.000Z"
    }
  ]
};

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(defaultStore, null, 2));
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
}

function writeStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
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
  if (!config) return null;
  const [collection, codeKey, nameKey] = config;
  const entity = store[collection].find(item => item.id === entityId);
  if (!entity) return null;
  return { code: entity[codeKey], name: entity[nameKey] || entity[codeKey] };
}

function enrichTransaction(store, transaction) {
  const qr = store.qrCodes.find(item => item.id === transaction.qrCodeId);
  const user = store.users.find(item => item.id === transaction.performedBy);
  const status = store.statuses.find(item => item.id === transaction.statusAfterId);
  const toLocation = store.locations.find(item => item.id === transaction.toLocationId);
  const entity = resolveEntity(store, transaction.entityType, transaction.entityId);
  const job = transaction.referenceJobId ? store.jobs.find(item => item.id === transaction.referenceJobId) : null;
  const workOrder = transaction.referenceWorkOrderId
    ? store.workOrders.find(item => item.id === transaction.referenceWorkOrderId)
    : null;

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
      code: entity ? entity.code : "-",
      name: entity ? entity.name : "-",
      qtyOnHand: balance.qtyOnHand,
      currentStatus: status ? status.statusName : "-",
      currentLocation: location ? location.locationName : "-",
      updatedAt: balance.updatedAt,
      unit: part ? part.unit : "",
      minStock: part ? part.minStock : 0,
      isLowStock: part ? Number(balance.qtyOnHand) <= Number(part.minStock) : false
    };
  });
}

function handleCreateTransaction(store, payload) {
  const qr = store.qrCodes.find(item => item.qrValue === payload.qrValue && item.isActive);
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
    referenceWorkOrderId: payload.workOrderId ? Number(payload.workOrderId) : null,
    statusAfterId: status ? status.id : null,
    performedBy: user.id,
    performedAt: new Date().toISOString(),
    remark: String(payload.remark || "").trim()
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

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
    const store = readStore();
    json(res, 200, {
      users: store.users,
      jobs: store.jobs,
      workOrders: store.workOrders,
      locations: store.locations,
      qrCodes: store.qrCodes
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/transactions") {
    const store = readStore();
    const q = requestUrl.searchParams.get("q");
    const action = requestUrl.searchParams.get("action");
    let rows = store.stockTransactions.map(item => enrichTransaction(store, item));
    if (q) {
      const needle = q.toLowerCase();
      rows = rows.filter(item =>
        [item.qrValue, item.entityCode, item.entityName, item.userName, item.jobNo, item.workOrderNo]
          .filter(Boolean)
          .some(value => value.toLowerCase().includes(needle))
      );
    }
    if (action) {
      rows = rows.filter(item => item.actionType === action.toUpperCase());
    }
    rows.sort((a, b) => new Date(b.performedAt) - new Date(a.performedAt));
    json(res, 200, rows);
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/transactions") {
    try {
      const store = readStore();
      const body = await parseBody(req);
      const result = handleCreateTransaction(store, body);
      json(res, result.statusCode, result.payload);
    } catch (error) {
      json(res, 500, { error: error.message || "Unexpected server error." });
    }
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/dashboard") {
    const store = readStore();
    json(res, 200, {
      balances: computeDashboard(store),
      recentTransactions: store.stockTransactions
        .slice()
        .sort((a, b) => new Date(b.performedAt) - new Date(a.performedAt))
        .slice(0, 5)
        .map(item => enrichTransaction(store, item))
    });
    return;
  }

  const publicPath = requestUrl.pathname === "/"
    ? path.join(PUBLIC_DIR, "index.html")
    : path.join(PUBLIC_DIR, requestUrl.pathname);

  if (publicPath.startsWith(PUBLIC_DIR)) {
    sendFile(res, publicPath);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

ensureStore();
server.listen(PORT, () => {
  console.log(`Stock QR MVP is running at http://localhost:${PORT}`);
});
