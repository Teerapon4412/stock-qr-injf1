const state = {
  bootstrap: null,
  scannerStream: null,
  detector: null,
  scanLoop: null,
  lookupTimer: null,
  lastLookup: null,
  masterSearch: "",
  masterEditing: null,
  masters: {
    parts: [],
    boxes: [],
    jobs: [],
    "work-orders": [],
    qrs: []
  }
};

function $(id) {
  return document.getElementById(id);
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const response = await fetch(url, { headers, ...options });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }
  return data;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("th-TH", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function setLookupMeta(lines) {
  const meta = $("lookup-meta");
  meta.innerHTML = "";

  lines.forEach(line => {
    const span = document.createElement("span");
    span.textContent = line;
    meta.appendChild(span);
  });
}

function parsedLines(parsed) {
  if (!parsed) return [];

  const lines = [];
  if (parsed.referenceNo) lines.push(`Ref No: ${parsed.referenceNo}`);
  if (parsed.partCode) lines.push(`Part Code: ${parsed.partCode}`);
  if (parsed.workOrderNo) lines.push(`WO: ${parsed.workOrderNo}`);
  if (parsed.qty !== null && parsed.qty !== undefined && parsed.qty !== "") lines.push(`QR Qty: ${parsed.qty}`);
  if (parsed.date) lines.push(`Date: ${parsed.date}`);
  if (parsed.process) lines.push(`Process: ${parsed.process}`);
  if (parsed.model) lines.push(`Model: ${parsed.model}`);
  return lines;
}

function renderSummaryList(targetId, rows) {
  const root = $(targetId);
  if (!root) return;

  root.innerHTML = rows.length
    ? rows.map(row => `
      <div class="summary-item">
        <dt>${row.label}</dt>
        <dd>${row.value}</dd>
      </div>
    `).join("")
    : '<div class="summary-empty">No data</div>';
}

function renderScanSummary(result) {
  const section = $("scan-summary");
  if (!section) return;

  const parsed = result?.parsed;
  const qrRows = [
    { label: "Part / Ref No.", value: parsed?.referenceNo || "-" },
    { label: "Part Code", value: parsed?.partCode || "-" },
    { label: "WO", value: parsed?.workOrderNo || "-" },
    { label: "QTY", value: parsed?.qty ?? "-" },
    { label: "Date", value: parsed?.date || "-" },
    { label: "Process", value: parsed?.process || "-" },
    { label: "Model", value: parsed?.model || "-" }
  ];

  const masterRows = [
    { label: "Matched QR", value: result?.matchedQrValue || "-" },
    { label: "Entity", value: result?.entityCode || "-" },
    { label: "Part Name", value: result?.entityName || "-" },
    { label: "Machine", value: result?.machines?.length ? result.machines.join(", ") : "-" },
    { label: "Material Code", value: result?.materialCodes?.length ? result.materialCodes.join(", ") : "-" }
  ];

  const hasParsedData = qrRows.some(row => row.value !== "-");
  const hasMasterData = Boolean(result?.found || result?.matchedQrValue);
  if (!hasParsedData && !hasMasterData) {
    section.classList.add("hidden");
    renderSummaryList("summary-qr-fields", []);
    renderSummaryList("summary-master-fields", []);
    return;
  }

  section.classList.remove("hidden");
  renderSummaryList("summary-qr-fields", qrRows);
  renderSummaryList("summary-master-fields", masterRows);
}

function renderLookup(result) {
  const card = $("lookup-card");
  if (!card) return;
  state.lastLookup = result || null;
  renderScanSummary(result);

  if (!result || !result.qrValue) {
    card.classList.add("hidden");
    $("lookup-title").textContent = "-";
    $("lookup-code").textContent = "-";
    setLookupMeta([]);
    return;
  }

  card.classList.remove("hidden");

  if (!result.found) {
    $("lookup-title").textContent = result.parsed?.partCode ? "Part not found in master" : "QR not found";
    $("lookup-code").textContent = result.qrValue;
    setLookupMeta([
      ...parsedLines(result.parsed),
      "Add this part code to master data before saving."
    ]);
    return;
  }

  $("lookup-title").textContent = result.entityName || result.entityCode || result.qrValue;
  $("lookup-code").textContent = `${result.entityType} | ${result.entityCode || result.matchedQrValue || result.qrValue}`;
  const lines = [...parsedLines(result.parsed)];
  if (result.matchedQrValue && result.matchedQrValue !== result.qrValue) lines.push(`Matched Part QR: ${result.matchedQrValue}`);
  if (result.machines && result.machines.length) lines.push(`Machine: ${result.machines.join(", ")}`);
  if (result.materialCodes && result.materialCodes.length) lines.push(`Material: ${result.materialCodes.join(", ")}`);
  setLookupMeta(lines);
}

async function lookupQr() {
  const qrValue = $("qrValue").value.trim();
  if (!qrValue) {
    renderLookup(null);
    return;
  }

  const result = await api(`/api/lookup/qr?value=${encodeURIComponent(qrValue)}`);
  renderLookup(result);
  if (!result.found) {
    $("form-message").textContent = "QR ยังไม่ถูกจับคู่กับข้อมูล master";
  } else if ($("form-message").textContent === "QR ยังไม่ถูกจับคู่กับข้อมูล master") {
    $("form-message").textContent = "";
  }
}

function scheduleLookup() {
  clearTimeout(state.lookupTimer);
  state.lookupTimer = setTimeout(() => {
    lookupQr().catch(error => {
      $("form-message").textContent = error.message;
    });
  }, 180);
}

async function lookupQr() {
  const qrValue = $("qrValue").value.trim();
  if (!qrValue) {
    renderLookup(null);
    return;
  }

  const result = await api(`/api/lookup/qr?value=${encodeURIComponent(qrValue)}`);
  renderLookup(result);

  if (result.parsed?.qty && (!$("qty").value || Number($("qty").value) === 1)) {
    $("qty").value = result.parsed.qty;
  }

  if (result.parsed?.workOrderNo && state.bootstrap?.workOrders?.length) {
    const matchedWorkOrder = state.bootstrap.workOrders.find(item => item.workOrderNo === result.parsed.workOrderNo);
    if (matchedWorkOrder) {
      $("workOrderId").value = matchedWorkOrder.id;
    }
  }

  if (!result.found) {
    $("form-message").textContent = result.parsed?.partCode
      ? `ยังไม่พบ Part Code ${result.parsed.partCode} ใน master`
      : "QR ยังไม่ถูกจับคู่กับข้อมูล master";
    return;
  }

  const currentMessage = $("form-message").textContent;
  if (currentMessage === "QR ยังไม่ถูกจับคู่กับข้อมูล master" || currentMessage.startsWith("ยังไม่พบ Part Code ")) {
    $("form-message").textContent = "";
  }
}

function renderOptions(select, items, placeholder, valueKey, labelBuilder) {
  select.innerHTML = "";
  const first = document.createElement("option");
  first.value = "";
  first.textContent = placeholder;
  select.appendChild(first);

  items.forEach(item => {
    const option = document.createElement("option");
    option.value = item[valueKey];
    option.textContent = labelBuilder(item);
    select.appendChild(option);
  });
}

async function loadBootstrap() {
  const data = await api("/api/bootstrap");
  state.bootstrap = data;

  renderOptions($("userId"), data.users, "เลือกผู้ทำรายการ", "id", item => `${item.employeeCode} - ${item.fullName}`);
  renderOptions($("jobId"), data.jobs, "ไม่ระบุงาน", "id", item => `${item.jobNo} - ${item.jobName}`);
  renderOptions($("workOrderId"), data.workOrders, "ไม่ระบุใบงาน", "id", item => item.workOrderNo);

  if (data.users[0]) $("userId").value = data.users[0].id;
  if (data.jobs[0]) $("jobId").value = data.jobs[0].id;
  if (data.workOrders[0]) $("workOrderId").value = data.workOrders[0].id;
}

function renderHistory(rows) {
  $("history-list").innerHTML = rows.length
    ? rows.map(item => `
      <article class="list-item">
        <div class="list-top">
          <div>
            <strong>${item.entityCode}</strong>
            <div>${item.entityName}</div>
          </div>
          <span class="badge ${item.actionType === "RECEIVE" ? "receive" : "issue"}">${item.actionType}</span>
        </div>
        <div class="list-meta">
          <span>QR: ${item.qrValue}</span>
          <span>จำนวน: ${item.qty}</span>
          <span>สถานะ: ${item.statusAfterName}</span>
          <span>ผู้ทำ: ${item.userName}</span>
          <span>เวลา: ${formatDate(item.performedAt)}</span>
        </div>
        <div class="list-meta">
          <span>งาน: ${item.jobNo || "-"}</span>
          <span>ใบงาน: ${item.workOrderNo || "-"}</span>
          <span>ปลายทาง: ${item.toLocationName || "-"}</span>
          <span>หมายเหตุ: ${item.remark || "-"}</span>
        </div>
      </article>
    `).join("")
    : '<div class="empty">ยังไม่พบรายการตามเงื่อนไขที่ค้นหา</div>';
}

function renderDashboard(data) {
  const totalBalances = data.balances.length;
  const lowStock = data.balances.filter(item => item.isLowStock).length;
  const totalQty = data.balances.reduce((sum, item) => sum + Number(item.qtyOnHand), 0);
  const recentCount = data.recentTransactions.length;
  const partCount = data.balances.filter(item => item.entityType === "PART").length;

  $("hero-recent-count").textContent = String(recentCount);
  $("hero-part-count").textContent = String(partCount);
  $("hero-balance-count").textContent = String(totalBalances);

  $("stats").innerHTML = `
    <div class="stat-card"><span>รายการคงเหลือ</span><strong>${totalBalances}</strong></div>
    <div class="stat-card"><span>ยอดรวมในระบบ</span><strong>${totalQty}</strong></div>
    <div class="stat-card"><span>ต่ำกว่า Min</span><strong>${lowStock}</strong></div>
    <div class="stat-card"><span>รายการล่าสุด</span><strong>${recentCount}</strong></div>
  `;

  $("balance-list").innerHTML = data.balances.length
    ? data.balances.map(item => `
      <article class="list-item">
        <div class="list-top">
          <div>
            <strong>${item.code}</strong>
            <div>${item.name}</div>
          </div>
          ${item.isLowStock ? '<span class="badge low">LOW STOCK</span>' : `<span>${item.entityType}</span>`}
        </div>
        <div class="list-meta">
          <span>คงเหลือ: ${item.qtyOnHand} ${item.unit || ""}</span>
          <span>สถานะ: ${item.currentStatus}</span>
          <span>ตำแหน่ง: ${item.currentLocation}</span>
          <span>อัปเดตล่าสุด: ${formatDate(item.updatedAt)}</span>
        </div>
      </article>
    `).join("")
    : '<div class="empty">ยังไม่มีข้อมูลคงเหลือ</div>';

  $("recent-list").innerHTML = data.recentTransactions.length
    ? data.recentTransactions.map(item => `
      <article class="list-item">
        <div class="list-top">
          <div>
            <strong>${item.transactionNo}</strong>
            <div>${item.entityCode} - ${item.entityName}</div>
          </div>
          <span class="badge ${item.actionType === "RECEIVE" ? "receive" : "issue"}">${item.actionType}</span>
        </div>
        <div class="list-meta">
          <span>จำนวน: ${item.qty}</span>
          <span>ผู้ทำ: ${item.userName}</span>
          <span>เวลา: ${formatDate(item.performedAt)}</span>
        </div>
      </article>
    `).join("")
    : '<div class="empty">ยังไม่มีรายการล่าสุด</div>';
}

function masterTitle(entity) {
  return {
    parts: "Part",
    boxes: "Box",
    jobs: "งาน",
    "work-orders": "ใบงาน",
    qrs: "QR"
  }[entity];
}

function renderMasters() {
  const needle = state.masterSearch.trim().toLowerCase();
  $("master-grid").innerHTML = Object.entries(state.masters).map(([entity, rows]) => {
    const filtered = rows.filter(item => {
      if (!needle) return true;
      return [item.code, item.name, item.extra1, item.extra2]
        .filter(value => value !== null && value !== undefined)
        .some(value => String(value).toLowerCase().includes(needle));
    });

    return `
    <section class="panel compact-panel">
      <div class="panel-head">
        <div>
          <h2>${masterTitle(entity)}</h2>
          <p>พบ ${filtered.length} รายการ</p>
        </div>
      </div>
      <div class="list">
        ${filtered.length
          ? filtered.slice(0, 20).map(item => `
            <article class="list-item">
              <div class="list-top">
                <strong>${item.code}</strong>
                <span>#${item.id}</span>
              </div>
              <div>${item.name || "-"}</div>
              <div class="list-meta">
                <span>Extra 1: ${item.extra1 ?? "-"}</span>
                <span>Extra 2: ${item.extra2 ?? "-"}</span>
              </div>
              <div class="button-row">
                <button class="secondary-button small-button" type="button" data-edit-entity="${entity}" data-edit-id="${item.id}">แก้ไข</button>
                <button class="secondary-button small-button danger-button" type="button" data-delete-entity="${entity}" data-delete-id="${item.id}">ลบ</button>
              </div>
            </article>
          `).join("")
          : '<div class="empty">ยังไม่มีข้อมูล</div>'}
      </div>
    </section>
  `;
  }).join("");

  document.querySelectorAll("[data-edit-entity]").forEach(button => {
    button.addEventListener("click", () => beginEditMaster(button.dataset.editEntity, Number(button.dataset.editId)));
  });
  document.querySelectorAll("[data-delete-entity]").forEach(button => {
    button.addEventListener("click", () => removeMaster(button.dataset.deleteEntity, Number(button.dataset.deleteId)));
  });
}

async function refreshMasters() {
  const entities = Object.keys(state.masters);
  const results = await Promise.all(entities.map(entity => api(`/api/master/${entity}`)));
  entities.forEach((entity, index) => {
    state.masters[entity] = results[index];
  });
  renderMasters();
}

async function refreshHistory() {
  const params = new URLSearchParams();
  const q = $("history-search").value.trim();
  const action = $("history-action").value;
  if (q) params.set("q", q);
  if (action) params.set("action", action);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const rows = await api(`/api/transactions${suffix}`);
  renderHistory(rows);
}

async function refreshDashboard() {
  const data = await api("/api/dashboard");
  renderDashboard(data);
}

async function submitTransaction(event) {
  event.preventDefault();
  $("form-message").textContent = "กำลังบันทึก...";

  const payload = {
    qrValue: $("qrValue").value.trim(),
    actionType: $("actionType").value,
    qty: Number($("qty").value),
    userId: $("userId").value,
    jobId: $("jobId").value,
    workOrderId: $("workOrderId").value,
    toLocationCode: $("toLocationCode").value.trim(),
    remark: $("remark").value.trim()
  };

  try {
    const result = await api("/api/transactions", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const transactionNo = result.transaction?.transactionNo || "saved";
    const qtyOnHand = result.balance?.qtyOnHand;
    $("form-message").textContent = qtyOnHand !== undefined
      ? `บันทึกแล้ว: ${transactionNo} | คงเหลือ ${qtyOnHand}`
      : `บันทึกแล้ว: ${transactionNo}`;
    $("transaction-form").reset();
    if (state.bootstrap?.users[0]) $("userId").value = state.bootstrap.users[0].id;
    if (state.bootstrap?.jobs[0]) $("jobId").value = state.bootstrap.jobs[0].id;
    if (state.bootstrap?.workOrders[0]) $("workOrderId").value = state.bootstrap.workOrders[0].id;
    $("qty").value = 1;
    renderLookup(null);
    await Promise.all([loadBootstrap(), refreshHistory(), refreshDashboard(), refreshMasters()]);
  } catch (error) {
    $("form-message").textContent = error.message;
  }
}

async function submitMaster(event) {
  event.preventDefault();
  $("master-message").textContent = "กำลังบันทึก...";

  const entity = $("masterEntity").value;
  const payload = {
    code: $("masterCode").value.trim(),
    name: $("masterName").value.trim(),
    extra1: $("masterExtra1").value.trim(),
    extra2: $("masterExtra2").value.trim()
  };

  try {
    if (state.masterEditing) {
      await api(`/api/master/${entity}/${state.masterEditing.id}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      $("master-message").textContent = "อัปเดต Master Data แล้ว";
    } else {
      await api(`/api/master/${entity}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      $("master-message").textContent = "บันทึก Master Data แล้ว";
    }
    $("master-form").reset();
    $("masterEntity").value = entity;
    state.masterEditing = null;
    await Promise.all([loadBootstrap(), refreshMasters()]);
  } catch (error) {
    $("master-message").textContent = error.message;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadCatalog(event) {
  event.preventDefault();
  const file = $("catalogFile").files[0];
  if (!file) {
    $("catalog-message").textContent = "Please choose an Excel file first.";
    return;
  }

  $("catalog-message").textContent = "Uploading catalog...";

  try {
    const contentBase64 = await fileToBase64(file);
    const result = await api("/api/master/import/catalog", {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        contentBase64
      })
    });

    $("catalog-message").textContent = `Catalog updated: ${result.totalParts} parts`;
    $("catalog-upload-form").reset();
    await Promise.all([loadBootstrap(), refreshMasters(), refreshDashboard()]);
  } catch (error) {
    $("catalog-message").textContent = error.message;
  }
}

function beginEditMaster(entity, id) {
  const item = state.masters[entity].find(row => row.id === id);
  if (!item) return;
  state.masterEditing = { entity, id };
  $("masterEntity").value = entity;
  $("masterCode").value = item.code || "";
  $("masterName").value = item.name || "";
  $("masterExtra1").value = item.extra1 ?? "";
  $("masterExtra2").value = item.extra2 ?? "";
  $("master-message").textContent = `กำลังแก้ไข ${masterTitle(entity)} #${id}`;
  activateView("master");
}

async function removeMaster(entity, id) {
  const ok = window.confirm(`ยืนยันการลบ ${masterTitle(entity)} #${id} ?`);
  if (!ok) return;
  try {
    await api(`/api/master/${entity}/${id}`, { method: "DELETE" });
    $("master-message").textContent = `ลบ ${masterTitle(entity)} #${id} แล้ว`;
    if (state.masterEditing?.entity === entity && state.masterEditing?.id === id) {
      state.masterEditing = null;
      $("master-form").reset();
    }
    await Promise.all([loadBootstrap(), refreshMasters()]);
  } catch (error) {
    $("master-message").textContent = error.message;
  }
}

function activateView(viewName) {
  document.querySelectorAll(".tab").forEach(button => {
    button.classList.toggle("is-active", button.dataset.view === viewName);
  });
  document.querySelectorAll(".view").forEach(view => {
    view.classList.toggle("is-active", view.id === `view-${viewName}`);
  });
}

async function startScanner() {
  if (!("BarcodeDetector" in window)) {
    $("form-message").textContent = "อุปกรณ์นี้ไม่รองรับ BarcodeDetector ใช้การกรอกรหัสแทนได้";
    return;
  }
  if (state.scannerStream) {
    stopScanner();
    return;
  }

  state.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
  state.scannerStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false
  });

  $("scanner-wrap").classList.remove("hidden");
  $("scanner").srcObject = state.scannerStream;
  await $("scanner").play();
  $("scan-toggle").textContent = "ปิดกล้องสแกน";

  const tick = async () => {
    if (!state.scannerStream) return;
    try {
      const codes = await state.detector.detect($("scanner"));
      if (codes[0]?.rawValue) {
        $("qrValue").value = codes[0].rawValue;
        $("form-message").textContent = `อ่าน QR ได้: ${codes[0].rawValue}`;
        await lookupQr();
        stopScanner();
        return;
      }
    } catch (error) {
      $("form-message").textContent = "สแกนไม่สำเร็จ ลองใหม่หรือกรอกรหัสแทน";
    }
    state.scanLoop = requestAnimationFrame(tick);
  };

  tick();
}

function stopScanner() {
  if (state.scanLoop) {
    cancelAnimationFrame(state.scanLoop);
    state.scanLoop = null;
  }
  if (state.scannerStream) {
    state.scannerStream.getTracks().forEach(track => track.stop());
    state.scannerStream = null;
  }
  $("scanner").srcObject = null;
  $("scanner-wrap").classList.add("hidden");
  $("scan-toggle").textContent = "เปิดกล้องสแกน";
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => activateView(button.dataset.view));
  });
  document.querySelectorAll("[data-view-target]").forEach(button => {
    button.addEventListener("click", () => activateView(button.dataset.viewTarget));
  });
  $("transaction-form").addEventListener("submit", submitTransaction);
  $("catalog-upload-form").addEventListener("submit", uploadCatalog);
  $("qrValue").addEventListener("input", scheduleLookup);
  $("qrValue").addEventListener("change", () => {
    lookupQr().catch(error => {
      $("form-message").textContent = error.message;
    });
  });
  $("master-form").addEventListener("submit", submitMaster);
  $("master-search").addEventListener("input", event => {
    state.masterSearch = event.target.value;
    renderMasters();
  });
  $("history-refresh").addEventListener("click", refreshHistory);
  $("history-search").addEventListener("input", refreshHistory);
  $("history-action").addEventListener("change", refreshHistory);
  $("scan-toggle").addEventListener("click", startScanner);
}

async function init() {
  bindEvents();
  await loadBootstrap();
  await Promise.all([refreshHistory(), refreshDashboard(), refreshMasters()]);
}

init().catch(error => {
  const el = $("form-message");
  if (el) el.textContent = error.message;
});
