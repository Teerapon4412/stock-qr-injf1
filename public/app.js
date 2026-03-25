const state = {
  bootstrap: null,
  scannerStream: null,
  detector: null,
  scanLoop: null,
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
  $("master-grid").innerHTML = Object.entries(state.masters).map(([entity, rows]) => `
    <section class="panel compact-panel">
      <div class="panel-head">
        <div>
          <h2>${masterTitle(entity)}</h2>
          <p>ล่าสุด ${rows.length} รายการ</p>
        </div>
      </div>
      <div class="list">
        ${rows.length
          ? rows.slice(0, 6).map(item => `
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
            </article>
          `).join("")
          : '<div class="empty">ยังไม่มีข้อมูล</div>'}
      </div>
    </section>
  `).join("");
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
    $("form-message").textContent = `บันทึกแล้ว: ${result.transaction.transactionNo} | คงเหลือ ${result.balance.qtyOnHand}`;
    $("transaction-form").reset();
    if (state.bootstrap?.users[0]) $("userId").value = state.bootstrap.users[0].id;
    if (state.bootstrap?.jobs[0]) $("jobId").value = state.bootstrap.jobs[0].id;
    if (state.bootstrap?.workOrders[0]) $("workOrderId").value = state.bootstrap.workOrders[0].id;
    $("qty").value = 1;
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
    await api(`/api/master/${entity}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    $("master-message").textContent = "บันทึก Master Data แล้ว";
    $("master-form").reset();
    $("masterEntity").value = entity;
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
  $("master-form").addEventListener("submit", submitMaster);
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
